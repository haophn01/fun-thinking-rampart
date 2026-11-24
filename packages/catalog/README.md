# @rampart/catalog

The NIST SP 800-171 Rev. 2 catalog as versioned data: 14 families, 110 requirements, 320
assessment objectives (from SP 800-171A) and the SPRS point value of each requirement
(32 CFR 170.24(c)(2)). The data is generated from NIST's PDFs by a conversion script and
committed as `data/nist-800-171-r2.json`.

## Use

```ts
import { catalogKey, getRequirement, loadCatalog } from '@rampart/catalog';

const catalog = loadCatalog(); // validated with the zod schema on first call, then cached
catalogKey(catalog); // "nist-800-171-r2@1.0.0", what an assessment records as catalog_version
getRequirement(catalog, 'AC.L2-3.1.1'); // the requirement, or undefined for an unknown id
```

- `parseCatalog(json)` validates any catalog JSON. It throws an `Error` that names every
  problem: duplicate ids, an objective under the wrong requirement, a requirement with no
  objectives, family lists that disagree with the requirements, or requirements out of
  numeric order.
- `normalizePracticeId(raw)` turns an id as the regulation prints it (`IA-L2-3.5.1`,
  `AC .L2- 3.1.19`) into the catalog form (`IA.L2-3.5.1`).
- `getRequirement` matches the id exactly; normalize first if the id comes from outside.
- The types in `src/types.ts` are frozen by the foundation sprint contract.

## Re-run the conversion

```sh
pnpm --filter @rampart/catalog convert
```

1. Each PDF is read from `sources/` (gitignored). A missing PDF is downloaded from its URL.
   If NIST has moved the file, the script prints the new URL; record it in
   `scripts/sources.json`.
2. Each file's SHA-256 must match its pin in `scripts/sources.json`. On a mismatch, or with no
   pin (`"sha256": null`), the script stops and writes nothing; the message gives the hash.
   Change a pin only after checking that NIST really published a new file, and bump
   `catalogVersion`. An assessment records the version it was made with.
3. pdfjs-dist extracts the text and `scripts/parse.ts` reads chapter three of both documents:
   - Page headers and the footnotes at the foot of a page are dropped.
   - Wrapped lines are joined. A line that ends in a hyphen joins the next with no space and
     keeps the hyphen (`security-` + `relevant` gives `security-relevant`). NIST's PDFs use
     no automatic hyphenation, so every such hyphen is a real one.
   - SP 800-171 gives each requirement's type from the "Basic / Derived Security
     Requirements" headings in its family. Footnote marks after a statement (`platforms.23`)
     are dropped.
   - SP 800-171A gives each statement and its lettered objectives (`3.1.1[a]`), followed
     across page breaks.
   - The 23 requirements whose SP 800-171A procedure has a single unlettered "Determine if
     ..." statement get it as objective `[a]` (for example `3.4.4[a]`), matching the
     contract's id form.
   - Both documents must list the same families and requirements. The statement text comes
     from SP 800-171A. Where SP 800-171 words a statement differently, the script stops
     unless `scripts/overrides.json` settles that requirement.
4. `scripts/points.cfr170-24.json` assigns points (see below). Then the overrides are applied,
   the result is validated with the schema, and the JSON is written in a stable layout
   (two-space indent, trailing newline). The same inputs always give byte-identical output.

## Sources

| Document               | URL                                                                         | SHA-256                                                            | Retrieved  |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------- |
| NIST SP 800-171 Rev. 2 | https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-171r2.pdf | `298bdbfcf6a4890a564b225c893230a0b32b2e69e3b98dd898aaeb1d544c5e12` | 2026-11-23 |
| NIST SP 800-171A       | https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-171A.pdf  | `21bf3acc43f4284f723639b82eb71e3ce597fa3610f7e9dcf5e8484e22bc0f71` | 2026-11-23 |

Neither URL had moved on 2026-11-23.

## Points

`scripts/points.cfr170-24.json` is transcribed from the Cornell LII text of
[32 CFR 170.24](https://www.law.cornell.edu/cfr/text/32/170.24), retrieved 2026-11-23. The id
lists keep the regulation's own spelling, stray spaces and `IA-L2-` included, and the script
normalizes them.

| Points          | Requirements                                                 | Citation                         |
| --------------- | ------------------------------------------------------------ | -------------------------------- |
| 5               | 23 basic requirements as listed                              | 32 CFR 170.24(c)(2)(i)(B)(1)(i)  |
| 5               | 19 derived requirements as listed                            | 32 CFR 170.24(c)(2)(i)(B)(1)(ii) |
| 3               | 7 basic requirements as listed                               | 32 CFR 170.24(c)(2)(i)(B)(2)(i)  |
| 3               | 7 derived requirements as listed                             | 32 CFR 170.24(c)(2)(i)(B)(2)(ii) |
| 1               | every other derived requirement (51)                         | 32 CFR 170.24(c)(2)(i)(B)(3)     |
| 5, or 3 partial | IA.L2-3.5.3 ("MFA covers remote and privileged users only")  | 32 CFR 170.24(c)(2)(i)(B)(4)(i)  |
| 5, or 3 partial | SC.L2-3.13.11 ("Encryption employed but not FIPS-validated") | 32 CFR 170.24(c)(2)(i)(B)(4)(ii) |
| prerequisite    | CA.L2-3.12.4 (system security plan)                          | 32 CFR 170.24(c)(2)(i)(B)(5)     |

That gives 44 at 5, 14 at 3 and 51 at 1, so the worst case is 110 − 313 = −203.

The script refuses an id that is not in the catalog, an id on two lists, an id on a list whose
basic/derived label disagrees with SP 800-171, and a basic requirement on no list (the
regulation gives 1 point only to derived ones).

## Overrides

`scripts/overrides.json` holds hand fixes keyed by requirement id (`AU.L2-3.3.2`) or objective
id (`3.1.9[b]`), each with its reason. The script refuses an override whose id matches
nothing, one listed twice, and one whose text equals the parsed text. Please spot-check each
one against the PDFs:

| Id            | Text in the catalog                                                                                                                          | Reason                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `AU.L2-3.3.2` | Ensure that the actions of individual system users can be uniquely traced to those users, so they can be held accountable for their actions. | SP 800-171 Rev. 2 (normative) has a comma after "those users" that the SP 800-171A restatement drops; the catalog keeps the SP 800-171 wording. |

No other text needed a hand fix. All 110 statements and 320 objectives were extracted as
printed.

## Tests

The tests never use the network or the PDFs:

- `src/catalog.test.ts` checks the committed JSON: counts, points, partial credit, the −203
  floor, objective ids, source metadata, and that every override appears above.
- `src/schema.test.ts` feeds the schema malformed catalogs.
- `scripts/parse.test.ts` runs the parser and the whole converter on `scripts/fixtures/`.
  These are short excerpts of the extracted text with each page separated by a `<<PAGE>>`
  line. They cover a page header, a footnote at the foot of a page, a hyphenated line break,
  an objective list that runs across a page break, and the start of the appendix.
- `scripts/points.test.ts` checks id normalization and the point-list guards.
