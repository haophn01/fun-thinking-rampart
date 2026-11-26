# Idea: Signed audit-log export

Status: parked

## The idea
Periodically export the audit log's hash-chain head, signed with a key kept outside the database (or sent to an external store), so even a full rewrite of the audit table is detectable.

## Why it's on hold
The in-DB hash chain with a Verify check comes first (security-hardening Q6 a). An in-DB chain can't stop someone who rewrites the whole table.

## What would make it worth building
Hosting is decided, there's a place outside the app to store the signed anchors, or an assessor asks for it.
