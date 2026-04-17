const createDocumentWorkflowRoutes = require('../modules/document-workflow/routes/documentWorkflowRoutes');

module.exports = function createInternalDocumentsWorkflowRouter(deps) {
  return createDocumentWorkflowRoutes(deps);
};
