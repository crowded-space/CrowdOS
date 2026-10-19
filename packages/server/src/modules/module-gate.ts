import type {
  ModelModule,
  InstructionModule,
  ToolkitModule,
  ConstraintsModule,
  CapabilitiesModule,
  ProviderEngine,
  ApiEndpoint,
  ThinkingLevel,
  ModuleType,
  ModuleUnion
} from "./module-types.js";
import {
  providerEngineSchema,
  apiEndpointSchema,
  thinkingLevelSchema,
  modelModuleSchema,
  updateModelModuleSchema,
  instructionModuleSchema,
  updateInstructionModuleSchema,
  toolkitModuleSchema,
  updateToolkitModuleSchema,
  constraintsModuleSchema,
  updateConstraintsModuleSchema,
  capabilitiesModuleSchema,
  updateCapabilitiesModuleSchema,
  paramIdSchema
} from "./module-validators.js";
import type {
  CreateModelModuleBody,
  UpdateModelModuleBody,
  CreateInstructionModuleBody,
  UpdateInstructionModuleBody,
  CreateToolkitModuleBody,
  UpdateToolkitModuleBody,
  CreateConstraintsModuleBody,
  UpdateConstraintsModuleBody,
  CreateCapabilitiesModuleBody,
  UpdateCapabilitiesModuleBody,
  ModuleParams
} from "./module-validators.js";
import {
  findReferencingAgent,
  findReferencingAgents,
  validateModuleReferences,
  testConnectionHelper,
  listAllModules,
  ensureDefaultModules,
  DEFAULT_INSTRUCTION_MODULE_ID,
  listModelModules,
  getModelModule,
  createModelModule,
  updateModelModule,
  deleteModelModule,
  testModelModule,
  listInstructionModules,
  getInstructionModule,
  createInstructionModule,
  updateInstructionModule,
  deleteInstructionModule,
  listToolkitModules,
  getToolkitModule,
  createToolkitModule,
  updateToolkitModule,
  deleteToolkitModule,
  listConstraintsModules,
  getConstraintsModule,
  createConstraintsModule,
  updateConstraintsModule,
  deleteConstraintsModule,
  listCapabilitiesModules,
  getCapabilitiesModule,
  createCapabilitiesModule,
  updateCapabilitiesModule,
  deleteCapabilitiesModule
} from "./module-service.js";

export type {
  ModelModule,
  InstructionModule,
  ToolkitModule,
  ConstraintsModule,
  CapabilitiesModule,
  ProviderEngine,
  ApiEndpoint,
  ThinkingLevel,
  ModuleType,
  ModuleUnion
};
export {
  providerEngineSchema,
  apiEndpointSchema,
  thinkingLevelSchema,
  modelModuleSchema,
  updateModelModuleSchema,
  instructionModuleSchema,
  updateInstructionModuleSchema,
  toolkitModuleSchema,
  updateToolkitModuleSchema,
  constraintsModuleSchema,
  updateConstraintsModuleSchema,
  capabilitiesModuleSchema,
  updateCapabilitiesModuleSchema,
  paramIdSchema
};
export type {
  CreateModelModuleBody,
  UpdateModelModuleBody,
  CreateInstructionModuleBody,
  UpdateInstructionModuleBody,
  CreateToolkitModuleBody,
  UpdateToolkitModuleBody,
  CreateConstraintsModuleBody,
  UpdateConstraintsModuleBody,
  CreateCapabilitiesModuleBody,
  UpdateCapabilitiesModuleBody,
  ModuleParams
};
export {
  findReferencingAgent,
  findReferencingAgents,
  validateModuleReferences,
  testConnectionHelper,
  listAllModules,
  ensureDefaultModules,
  DEFAULT_INSTRUCTION_MODULE_ID,
  listModelModules,
  getModelModule,
  createModelModule,
  updateModelModule,
  deleteModelModule,
  testModelModule,
  listInstructionModules,
  getInstructionModule,
  createInstructionModule,
  updateInstructionModule,
  deleteInstructionModule,
  listToolkitModules,
  getToolkitModule,
  createToolkitModule,
  updateToolkitModule,
  deleteToolkitModule,
  listConstraintsModules,
  getConstraintsModule,
  createConstraintsModule,
  updateConstraintsModule,
  deleteConstraintsModule,
  listCapabilitiesModules,
  getCapabilitiesModule,
  createCapabilitiesModule,
  updateCapabilitiesModule,
  deleteCapabilitiesModule
};

export const moduleGate = {
  findReferencingAgent,
  findReferencingAgents,
  validateReferences: validateModuleReferences,
  ensureDefaults: ensureDefaultModules,
  model: {
    list: listModelModules,
    get: getModelModule,
    create: createModelModule,
    update: updateModelModule,
    remove: deleteModelModule,
    test: testModelModule
  },
  instruction: {
    list: listInstructionModules,
    get: getInstructionModule,
    create: createInstructionModule,
    update: updateInstructionModule,
    remove: deleteInstructionModule
  },
  toolkit: {
    list: listToolkitModules,
    get: getToolkitModule,
    create: createToolkitModule,
    update: updateToolkitModule,
    remove: deleteToolkitModule
  },
  constraints: {
    list: listConstraintsModules,
    get: getConstraintsModule,
    create: createConstraintsModule,
    update: updateConstraintsModule,
    remove: deleteConstraintsModule
  },
  capabilities: {
    list: listCapabilitiesModules,
    get: getCapabilitiesModule,
    create: createCapabilitiesModule,
    update: updateCapabilitiesModule,
    remove: deleteCapabilitiesModule
  }
};
