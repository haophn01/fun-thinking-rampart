// Reads an exported .docx back as text. The api's SSP tests already own the reader (fflate unzips
// `word/document.xml`; one line per paragraph, each table cell its own); e2e reuses it rather than
// keep a second copy that could drift from what S3 tests.
export { docxText } from '../../apps/api/ssp/testing/docx-text.ts';
