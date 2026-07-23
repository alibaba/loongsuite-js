// Copyright The OpenTelemetry Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

export const GEN_AI_TOOL_DEFINITIONS = "gen_ai.tool.definitions";
export const GEN_AI_EMBEDDINGS_DIMENSION_COUNT =
  "gen_ai.embeddings.dimension.count";
export const GEN_AI_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments";
export const GEN_AI_TOOL_CALL_RESULT = "gen_ai.tool.call.result";
export const GEN_AI_SKILL_ID = "gen_ai.skill.id";
export const GEN_AI_SKILL_NAME = "gen_ai.skill.name";
export const GEN_AI_SKILL_VERSION = "gen_ai.skill.version";
export const GEN_AI_SKILL_DESCRIPTION = "gen_ai.skill.description";
export const GEN_AI_RETRIEVAL_QUERY_TEXT = "gen_ai.retrieval.query.text";
export const GEN_AI_RETRIEVAL_DOCUMENTS = "gen_ai.retrieval.documents";
export const GEN_AI_RERANK_DOCUMENTS_COUNT = "gen_ai.rerank.documents.count";
export const GEN_AI_RERANK_SCORING_PROMPT = "gen_ai.rerank.scoring_prompt";
export const GEN_AI_RERANK_RETURN_DOCUMENTS = "gen_ai.rerank.return_documents";
export const GEN_AI_RERANK_MAX_CHUNKS_PER_DOC =
  "gen_ai.rerank.max_chunks_per_doc";
export const GEN_AI_RERANK_DEVICE = "gen_ai.rerank.device";
export const GEN_AI_RERANK_BATCH_SIZE = "gen_ai.rerank.batch_size";
export const GEN_AI_RERANK_MAX_LENGTH = "gen_ai.rerank.max_length";
export const GEN_AI_RERANK_NORMALIZE = "gen_ai.rerank.normalize";
export const GEN_AI_RERANK_INPUT_DOCUMENTS = "gen_ai.rerank.input_documents";
export const GEN_AI_RERANK_OUTPUT_DOCUMENTS = "gen_ai.rerank.output_documents";
export const GEN_AI_SPAN_KIND = "gen_ai.span.kind";
export const GEN_AI_INPUT_MULTIMODAL_METADATA =
  "gen_ai.input.multimodal_metadata";
export const GEN_AI_OUTPUT_MULTIMODAL_METADATA =
  "gen_ai.output.multimodal_metadata";
export const GEN_AI_USAGE_TOTAL_TOKENS = "gen_ai.usage.total_tokens";
export const GEN_AI_RESPONSE_TIME_TO_FIRST_TOKEN =
  "gen_ai.response.time_to_first_token";
export const GEN_AI_SESSION_ID = "gen_ai.session.id";
export const GEN_AI_USER_ID = "gen_ai.user.id";
export const GEN_AI_REACT_FINISH_REASON = "gen_ai.react.finish_reason";
export const GEN_AI_REACT_ROUND = "gen_ai.react.round";
export const GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS =
  "gen_ai.usage.cache_creation.input_tokens";
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS =
  "gen_ai.usage.cache_read.input_tokens";

// Standard GenAI attribute keys used from OTel semconv
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
export const GEN_AI_RESPONSE_ID = "gen_ai.response.id";
export const GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons";
export const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const GEN_AI_REQUEST_TEMPERATURE = "gen_ai.request.temperature";
export const GEN_AI_REQUEST_TOP_P = "gen_ai.request.top_p";
export const GEN_AI_REQUEST_TOP_K = "gen_ai.request.top_k";
export const GEN_AI_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens";
export const GEN_AI_REQUEST_FREQUENCY_PENALTY =
  "gen_ai.request.frequency_penalty";
export const GEN_AI_REQUEST_PRESENCE_PENALTY =
  "gen_ai.request.presence_penalty";
export const GEN_AI_REQUEST_STOP_SEQUENCES = "gen_ai.request.stop_sequences";
export const GEN_AI_REQUEST_SEED = "gen_ai.request.seed";
export const GEN_AI_REQUEST_ENCODING_FORMATS =
  "gen_ai.request.encoding_formats";
export const GEN_AI_REQUEST_CHOICE_COUNT = "gen_ai.request.choice.count";
export const GEN_AI_OUTPUT_TYPE = "gen_ai.output.type";
export const GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id";
export const GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages";
export const GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages";
export const GEN_AI_SYSTEM_INSTRUCTIONS = "gen_ai.system_instructions";
export const GEN_AI_AGENT_ID = "gen_ai.agent.id";
export const GEN_AI_AGENT_NAME = "gen_ai.agent.name";
export const GEN_AI_AGENT_DESCRIPTION = "gen_ai.agent.description";
export const GEN_AI_DATA_SOURCE_ID = "gen_ai.data_source.id";
export const GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";
export const GEN_AI_TOOL_NAME = "gen_ai.tool.name";
export const GEN_AI_TOOL_DESCRIPTION = "gen_ai.tool.description";
export const GEN_AI_TOOL_TYPE = "gen_ai.tool.type";
export const GEN_AI_FRAMEWORK = "gen_ai.framework";
export const SERVER_ADDRESS = "server.address";
export const SERVER_PORT = "server.port";
export const ERROR_TYPE = "error.type";

export const GEN_AI_CLIENT_OPERATION_DURATION =
  "gen_ai.client.operation.duration";
export const GEN_AI_CLIENT_TOKEN_USAGE = "gen_ai.client.token.usage";
export const GEN_AI_TOKEN_TYPE = "gen_ai.token.type";

export enum GenAiSpanKindValues {
  AGENT = "AGENT",
  LLM = "LLM",
  EMBEDDING = "EMBEDDING",
  TOOL = "TOOL",
  RETRIEVER = "RETRIEVER",
  RERANKER = "RERANKER",
  MEMORY = "MEMORY",
  ENTRY = "ENTRY",
  STEP = "STEP",
}

export enum GenAiExtendedOperationNameValues {
  RETRIEVAL = "retrieval",
  RERANK_DOCUMENTS = "rerank_documents",
  ENTER = "enter",
  REACT = "react",
}

export enum GenAiOperationNameValues {
  CHAT = "chat",
  TEXT_COMPLETION = "text_completion",
  GENERATE_CONTENT = "generate_content",
  CREATE_AGENT = "create_agent",
  INVOKE_AGENT = "invoke_agent",
  EXECUTE_TOOL = "execute_tool",
  EMBEDDINGS = "embeddings",
}

export enum GenAiTokenTypeValues {
  INPUT = "input",
  OUTPUT = "output",
}

export enum GenAiExtendedProviderNameValues {
  DASHSCOPE = "dashscope",
  OLLAMA = "ollama",
  MOONSHOT = "moonshot",
}
