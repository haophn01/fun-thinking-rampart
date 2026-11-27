// The contract shared with the web app. Files under contract/ import only `zod` or each other,
// so the browser bundle can use them.

/** The product name. Nothing else in the codebase spells it. */
export const PRODUCT_NAME = 'Rampart';

// First: in the browser it makes zod jitless before any schema below is built.
export * from './browser';
export * from './error';
export * from './health';
export * from './common';
export * from './auth';
export * from './users';
export * from './audit';
export * from './evaluation';
export * from './assessment';
export * from './files';
export * from './poam';
export * from './evidence';
export * from './policies';
export * from './system-profile';
export * from './ssp';
export * from './ssp-data';
export * from './ssp-lint';
