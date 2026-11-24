# Idea: Encrypted CUI evidence storage and hosting

Status: parked

## The idea
Let evidence that contains CUI live in the tool. This needs:
- encryption at rest, with managed keys
- an evidence-store backend beyond the local folder (S3 GovCloud or Azure Government Blob)
- backups
- a hosting target that meets DFARS 252.204-7012: a FedRAMP Moderate equivalent cloud provider, or a self-hosted deployment inside the contractor's CMMC enclave

The "contains CUI" flag from V1 then unlocks file uploads instead of blocking them. From the research: [cmmc-l2-grc](../research/cmmc-l2-grc.md). Even Secureframe says its platform can't store CUI, which makes this a gap the tool could fill.

## Why it's on hold
V1 of plan `cmmc-l2-grc` runs on a local dev machine and stores no real CUI. Hosting hasn't been decided. Storage already sits behind an interface, so this won't change the data model.

## What would make it worth building
A decision on where the app runs (in the enclave or in a FedRAMP Moderate equivalent cloud), and a real need to keep CUI-bearing evidence next to the assessment rather than as references.
