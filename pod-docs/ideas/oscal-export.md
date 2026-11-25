# Idea: OSCAL export of the SSP and POA&M

Status: parked

## The idea
Export the SSP and POA&M as OSCAL JSON (SSP and POA&M models, OSCAL 1.2.x), with a root `uuid` and `last-modified` on each document. Validate the exports with compliance-trestle (Apache-2.0). That way they can go into other GRC tools or eMASS-style workflows, and live in Git. From the research: [cmmc-l2-grc](../research/cmmc-l2-grc.md). Paramify already offers an OSCAL-based SSP, and NIST publishes the SSP and POA&M model docs.

## Why it's on hold
It's out of scope for the V1 plan `cmmc-l2-grc`. Word (.docx) is the SSP format assessors expect first. The data model is kept OSCAL-compatible (UUIDs, an implementation-status enum) so this can come later.

## What would make it worth building
The V1 SSP and POA&M data being stable, plus a consumer that asks for OSCAL: an assessor, a prime contractor, or another tool.
