# Changelog

## [0.2.2](https://github.com/rambaarde/ai-prompt-search/compare/v0.2.1...v0.2.2) (2026-08-15)


### Bug Fixes

* **npm:** name the repository, so provenance can verify it ([736b68b](https://github.com/rambaarde/ai-prompt-search/commit/736b68ba3243c8db2f430f395cb6352ae385ffb8))

## [0.2.1](https://github.com/rambaarde/ai-prompt-search/compare/v0.2.0...v0.2.1) (2026-08-15)


### Bug Fixes

* **ci:** install the npm that can actually do the OIDC exchange ([bcd0edc](https://github.com/rambaarde/ai-prompt-search/commit/bcd0edc06ba225e8bc90d483bee0be665ab72d03))

## [0.2.0](https://github.com/rambaarde/ai-prompt-search/compare/v0.1.0...v0.2.0) (2026-08-15)


### ⚠ BREAKING CHANGES

* aps now shows only the current project's prompts. Pass -A for the previous behaviour.

### Features

* scope prompts to the current project by default ([d9a6c8d](https://github.com/rambaarde/ai-prompt-search/commit/d9a6c8de0cc937fd82a1b986134c2224c140a4d9))
* search and reuse your prompts across every AI CLI ([4395fc9](https://github.com/rambaarde/ai-prompt-search/commit/4395fc90a8f484dba2a1bb2f27568d2ac7466804))
* **tui:** a smaller centred panel, like a browser omnibox ([bfd618c](https://github.com/rambaarde/ai-prompt-search/commit/bfd618c361fc5039229f12ccc2ad2a637733f0cd))


### Bug Fixes

* **ci:** let node discover the tests, without a shell or a path ([75ea3f6](https://github.com/rambaarde/ai-prompt-search/commit/75ea3f6992ce7af53a170eb3c8536e8d62255f81))
* **ci:** let node find the test files, not the shell ([c4225a8](https://github.com/rambaarde/ai-prompt-search/commit/c4225a8148de9afd0c1d73e96a25e0c9df44806a))
* **opencode:** read prompts from parts — it was returning nothing ([31229d5](https://github.com/rambaarde/ai-prompt-search/commit/31229d5a6744b76df0a323df67932dbbb17d442c))
* **scope:** a subdirectory belongs to its project on Windows too ([8619ab1](https://github.com/rambaarde/ai-prompt-search/commit/8619ab1db27b516d68f73501a3ad9001ba6a79df))
