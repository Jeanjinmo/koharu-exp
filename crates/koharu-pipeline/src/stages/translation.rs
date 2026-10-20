use anyhow::Result;
use async_trait::async_trait;
use koharu_scene::{
    Authored, EntityId, LanguageTag, Origin, ReferenceText, SourceText, Translation,
};
use koharu_translator::{Language, SegmentReference, TranslationRequest, Translator};

use crate::TranslationConfig;

use super::{StageInput, StageProcessor, finish, generation};

const PRODUCER: &str = "dev.koharu.pipeline.translation";

pub(super) struct Processor {
    config: TranslationConfig,
    translator: Translator,
}

impl Processor {
    pub(super) fn new(config: TranslationConfig, translator: Translator) -> Self {
        Self { config, translator }
    }
}

/// One text content of the page and how to translate it.
enum Target {
    /// Sent to the translator, with what the page's reference says there.
    Translate {
        content: EntityId,
        source: String,
        reference: Option<SegmentReference>,
    },
    /// The reference is already in the target language, so it is the
    /// translation as it is.
    Copy { content: EntityId, text: String },
}

impl Processor {
    fn target_language(&self) -> Result<LanguageTag> {
        Ok(LanguageTag::new(self.config.target_language.tag())?)
    }

    fn in_target_language(&self, language: &LanguageTag) -> bool {
        language
            .as_str()
            .parse::<Language>()
            .is_ok_and(|language| language == self.config.target_language)
    }

    fn targets(&self, input: &StageInput) -> Result<Vec<Target>> {
        let mut targets = Vec::new();
        let Some(group) = input.scene.page(input.page)?.text_group()? else {
            return Ok(targets);
        };
        for layer in group.text_layers()? {
            if !input.contains_entity(layer.id())? {
                continue;
            }
            let content = layer.content()?;
            let Some(source) = content.source()? else {
                continue;
            };
            let reference = content.reference()?;
            match reference {
                Some(reference) if self.in_target_language(&reference.language) => {
                    targets.push(Target::Copy {
                        content: content.id(),
                        text: reference.text.value,
                    });
                }
                reference if !source.text.value.trim().is_empty() || reference.is_some() => {
                    targets.push(Target::Translate {
                        content: content.id(),
                        source: source.text.value,
                        reference: reference.map(|reference| SegmentReference {
                            language: reference.language.as_str().parse::<Language>().map_or_else(
                                |_| reference.language.to_string(),
                                |language| language.to_string(),
                            ),
                            text: reference.text.value,
                        }),
                    });
                }
                _ => {}
            }
        }
        Ok(targets)
    }
}

#[async_trait]
impl StageProcessor for Processor {
    fn model(&self) -> &'static str {
        Translator::model(&self.config.model)
    }

    // A page whose text all copies references that are already in place needs
    // no translator, so it is skipped before the model loads.
    fn skip(&self, input: &StageInput) -> Result<bool> {
        let targets = self.targets(input)?;
        if targets.is_empty() {
            return Ok(false);
        }
        for target in targets {
            let Target::Copy { content, text } = target else {
                return Ok(false);
            };
            let current = input.scene.component::<Translation>(content)?;
            if !current.is_some_and(|current| {
                matches!(current.text.origin, Origin::User) || current.text.value == text
            }) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn unload(&self) -> bool {
        self.translator.unload()
    }

    async fn load(&self) -> Result<()> {
        self.translator.load_model(&self.config.model).await
    }

    async fn process(&self, input: StageInput) -> Result<koharu_scene::Patch> {
        let targets = self.targets(&input)?;
        let mut segments = Vec::new();
        let mut references = Vec::new();
        for target in &targets {
            if let Target::Translate {
                source, reference, ..
            } = target
            {
                if let Some(reference) = reference {
                    references.push((segments.len(), reference.clone()));
                }
                segments.push(source.clone());
            }
        }
        let (provider, mut translated) = if segments.is_empty() {
            ("reference", Vec::new().into_iter())
        } else {
            let mut request = TranslationRequest::new(segments, self.config.target_language)
                .with_references(references);
            if let Some(instructions) = self.config.instructions.as_deref() {
                request = request.with_instructions(instructions);
            }
            if Translator::supports_vision(&self.config.model, &self.config.generation)
                && let Some(image) = input.images.get(&input.scene, input.page, "source").await?
            {
                request = request.with_image(image);
            }
            let (provider, translated) = self
                .translator
                .translate(&self.config.model, self.config.generation, request)
                .await?;
            (provider, translated.into_iter())
        };
        let language = self.target_language()?;
        let generated = generation(PRODUCER, provider)?;
        let mut edit = input.scene.edit_as(generated.clone());
        for target in &targets {
            let (Target::Translate { content, .. } | Target::Copy { content, .. }) = target;
            edit.observe::<SourceText>(*content)?;
            edit.observe::<ReferenceText>(*content)?;
            edit.observe::<Translation>(*content)?;
        }
        for target in targets {
            let (content, text) = match target {
                Target::Translate {
                    content, source, ..
                } => {
                    let Some(text) = translated.next() else {
                        continue;
                    };
                    let text = if source.trim() == "\u{2026}" {
                        "\u{2026}".to_owned()
                    } else {
                        text
                    };
                    (content, text)
                }
                Target::Copy { content, text } => (content, text),
            };
            if input
                .scene
                .component::<Translation>(content)?
                .is_some_and(|value| matches!(value.text.origin, Origin::User))
            {
                continue;
            }
            edit.set(
                content,
                &Translation {
                    text: Authored::generated(text, generated.clone()),
                    language: Some(language.clone()),
                },
            )?;
        }
        finish(edit)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use koharu_scene::{At, PageDraft, Session, TextLayout, TextLayoutKind};

    use super::*;
    use crate::ImageCache;

    #[tokio::test]
    async fn references_in_the_target_language_become_the_translation_without_a_translator() {
        let mut session = Session::memory().await.unwrap();
        let mut setup = session.snapshot().edit();
        let page = setup
            .add_page(PageDraft::new("page", 100.0, 100.0), At::End)
            .unwrap();
        let content = setup.add_text_content(page, At::End).unwrap();
        setup
            .set(
                content,
                &SourceText {
                    text: Authored::user("どこ?".to_owned()),
                    language: None,
                },
            )
            .unwrap();
        setup
            .set(
                content,
                &ReferenceText {
                    text: Authored::user("WHERE?".to_owned()),
                    language: LanguageTag::new("en-US").unwrap(),
                },
            )
            .unwrap();
        setup
            .add_text_layer(
                page,
                At::End,
                content,
                &TextLayout {
                    origin: Origin::User,
                    kind: TextLayoutKind::Paragraph,
                    angle_degrees: None,
                },
            )
            .unwrap();
        session.commit(setup.finish().unwrap()).await.unwrap();
        let translator = Translator::from_config(
            koharu_ml::Device::cpu(),
            koharu_config::Config::memory(koharu_translator::ProvidersConfig::default()),
        )
        .unwrap();
        let processor = Processor::new(TranslationConfig::default(), translator);
        let input = |scene| {
            StageInput::new(
                scene,
                page,
                None,
                None,
                Arc::new(ImageCache::default()),
                None,
            )
        };

        assert!(!processor.skip(&input(session.snapshot())).unwrap());
        let patch = processor.process(input(session.snapshot())).await.unwrap();
        let snapshot = session.commit(patch).await.unwrap().snapshot;
        let translation = snapshot.component::<Translation>(content).unwrap().unwrap();
        assert_eq!(translation.text.value, "WHERE?");
        assert_eq!(translation.language.unwrap().as_str(), "en-US");
        assert!(processor.skip(&input(snapshot)).unwrap());
    }
}
