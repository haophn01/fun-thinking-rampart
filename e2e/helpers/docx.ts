// Reads an exported .docx back: its text and its media parts. The api's SSP tests already own the
// reader (fflate unzips `word/document.xml`; one line per paragraph, each table cell its own);
// e2e reuses it rather than keep a second copy that could drift from what the api tests.
export { docxMedia, docxText } from '../../apps/api/ssp/testing/docx-text.ts';
