/**
 * elkjs' bundled build checks for a worker context (`self` without `document`) when it loads and,
 * if it finds one, takes over `self.onmessage` instead of exporting its in-process engine, which
 * makes `new ELK()` throw. A placeholder `document` while the layout module loads keeps it on the
 * in-process path. This module must be imported before anything that pulls in elkjs.
 */
const scope = globalThis as { document?: unknown; __opsdrawFakeDocument?: boolean };
if (typeof scope.document === 'undefined') {
  scope.document = {};
  scope.__opsdrawFakeDocument = true;
}

export function restoreWorkerGlobals() {
  if (scope.__opsdrawFakeDocument) {
    delete scope.document;
    delete scope.__opsdrawFakeDocument;
  }
}
