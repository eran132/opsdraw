# Contributing

Thanks for helping. A few rules keep the project healthy and legally clean:

- One pull request per change, branched from `main`. Use conventional commits (`feat:`, `fix:`,
  `docs:`, `test:`, `chore:`).
- Run `npm run lint`, `npm run format:check`, `npm test` and `npm run test:e2e` before pushing.
- Read [TRADEMARKS.md](TRADEMARKS.md). Never commit vendor icons or logos.
- Contributions are accepted under the Apache License 2.0 (see LICENSE), per section 5 of the
  license.

## Translations

UI strings live in `packages/app/src/i18n/<lang>.ts`, one file per language, typed against
`en.ts`. Corrections from native speakers are very welcome. Keep `{{placeholders}}` unchanged and
keep product names (Terraform, Mermaid, AWS…) untranslated. Right-to-left languages are marked
`rtl: true` in `packages/app/src/i18n/index.ts`.
