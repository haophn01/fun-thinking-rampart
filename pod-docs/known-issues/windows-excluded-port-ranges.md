# Windows reserves TCP port ranges, so some dev ports can't be bound

_Found: 2026-11-24 · by: S2 (assessment) · plan: cmmc-l2-grc_

**What happens:** starting a dev server on a port in 3057–3156 fails with `listen EACCES 127.0.0.1:<port>`, even though nothing is listening there. Windows (Hyper-V / WSL / winnat) reserves these ranges. `netsh interface ipv4 show excludedportrange protocol=tcp` lists them. On 2026-11-24 they were:
- 2653–2852 and 2855–2954
- **3057–3156**
- 4442–4443 and 5357
- 11818–11917 and 13508
- 31845–32144 and 32305–32404
- 50000–50059 and 50131
- 60343–60442

**Rule for pod runs on this machine:** never use a port in a reserved range. Run `netsh … excludedportrange` before claiming a port base. The ranges can change after a reboot or a Hyper-V / WSL restart.

**This run:** plan `cmmc-l2-grc` moved from port base 3000 to **3200** (3200–3299 is clear). Slice *i* uses 3200+10i / 3201+10i. The default app ports in the smoke recipe (web 3000, api 3001) are below the reserved range and still work.
