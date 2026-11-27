# Password blocklist sources

`common-passwords.json` is the bundled offline blocklist that `isBlocklisted` (in `index.ts`) checks
when a password is set. It is generated; never edit it by hand.

| Field          | Value                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project        | SecLists, by Daniel Miessler and contributors                                                                                                                             |
| Licence        | MIT (`LICENSE` at the root of the SecLists repository)                                                                                                                    |
| Path           | `Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt`                                                                                                  |
| Commit         | `c205c36a445bff37f8e58a9ec829105cd4975c58` (the last commit to change that file, 2025-05-08)                                                                              |
| URL            | https://raw.githubusercontent.com/danielmiessler/SecLists/c205c36a445bff37f8e58a9ec829105cd4975c58/Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt |
| SHA-256        | `424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51` (the downloaded file, 8,557,632 bytes)                                                                 |
| Downloaded     | 2026-11-26                                                                                                                                                                |
| Upstream count | 1,000,000 lines                                                                                                                                                           |
| Kept count     | 46146                                                                                                                                                                     |

## What is kept

`scripts/build-blocklist.ts` keeps the lines of 12 to 128 characters (UTF-16 units, as
`passwordSchema` counts them), because shorter or longer ones are refused by the policy anyway. It
drops lines with control characters, invalid UTF-8 or U+FFFD, lowercases, removes duplicates and
sorts by UTF-16 code unit. The same download always gives the same file, byte for byte.

## Rebuilding

1. Download the URL above into a new, empty folder outside the repo. The file is data: never run it.
2. Check its SHA-256 against the value above (`sha256sum <file>`). A different hash means a different
   list: update this file with the new commit, hash, date and counts.
3. From the repo root, run `node scripts/build-blocklist.ts <file>`. It prints the kept and upstream
   counts and writes `common-passwords.json` here.
4. Run `pnpm vitest run apps/api/src/auth/blocklist` to check the list against this record.

## Licence notice

SecLists is distributed under the MIT License:

> Copyright (c) 2018 Daniel Miessler
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
> OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
