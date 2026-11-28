# Idea: Virus scanning of uploads

Status: parked

## The idea
Scan evidence and policy uploads with ClamAV (or a similar engine) before storing them, and quarantine detections.

## Why it's on hold
The byte-based allowlist and zip-bomb guard come first (security-hardening Q5 a). A scanner adds a daemon and signature updates to run.

## What would make it worth building
Rampart is hosted or shared by more people, or uploads come from outside the core team.
