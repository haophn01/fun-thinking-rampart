# Idea: Evidence integrations and SSO

Status: parked

## The idea
Pull evidence automatically, the way Vanta and Secureframe Defense do: M365 GCC High / Entra ID (MFA, conditional access, users), Intune GCC High, AWS GovCloud and Azure Government (configuration, logging, encryption), and endpoint tools. Map each pull to the 800-171A objectives it supports and keep it fresh on a schedule. Add single sign-on (Entra ID) in place of local accounts. From the research: [cmmc-l2-grc](../research/cmmc-l2-grc.md).

## Why it's on hold
V1 of plan `cmmc-l2-grc` is workflow first, with manual evidence and local accounts. Integrations need a hosting and credentials story, and the objective-level data model has to exist first.

## What would make it worth building
V1 in use, with manual evidence collection the biggest time sink, and a decision on where the app runs (integrations need secrets and network access to GCC High or GovCloud).
