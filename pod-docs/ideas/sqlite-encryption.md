# Idea: Encrypt the SQLite database file

Status: parked

## The idea
Encrypt the database file itself (SQLCipher or a similar extension) instead of relying on the host's disk encryption, with key management for local and hosted runs.

## Why it's on hold
Research didn't cover SQLite encryption options, and host disk encryption is the plan's documented answer. A native encryption extension complicates builds on Windows and Linux.

## What would make it worth building
Rampart is hosted somewhere without disk encryption, or a CUI storage decision requires app-level encryption (see cui-storage-hosting).
