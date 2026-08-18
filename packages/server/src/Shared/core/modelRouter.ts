import { getDb } from "../config/database.js";

/**
 * Checks if the model name string indicates a Gemma model.
 */
export function isGemmaModel(modelName: string): boolean {
  return modelName.toLowerCase().includes("gemma");
}

/**
 * Enforces strict Gemma 4 validations.
 * If the model name is Gemma but not Gemma 4, immediately rejects the configuration and warns the user.
 */
export function validateGemmaModel(modelName: string): void {
  const nameLower = modelName.toLowerCase();
  if (nameLower.includes("gemma") && !nameLower.includes("gemma-4")) {
    throw new Error(`Legacy Gemma variant rejected. CrowdOS Google Provider exclusively supports Gemma 4 (e.g., gemma-4-*). Please configure a gemma-4 model.`);
  }
}

/**
 * Parses and extracts reasoning thoughts from Gemma 4's inline tags.
 * Supports:
 * - <|channel>thought ... <channel|>;
 * - <|think|> ... </|think|>;
 * - <thought> ... </thought>;
 */
export function parseGemmaThoughts(text: string): { thoughts: string; answer: string } {
  const delimiters = [
    { start: "<|channel>thought", end: "<channel|>" },
    { start: "<|think|>", end: "</|think|>" },
    { start: "<thought>", end: "</thought>" }
  ];

  let thoughts = "";
  let answer = text;

  for (const delim of delimiters) {
    const startIndex = answer.indexOf(delim.start);
    if (startIndex !== -1) {
      const endIndex = answer.indexOf(delim.end, startIndex + delim.start.length);
      if (endIndex !== -1) {
        thoughts = answer.slice(startIndex + delim.start.length, endIndex).trim();
        answer = (answer.slice(0, startIndex) + answer.slice(endIndex + delim.end.length)).trim();
      }
    }
  }

  return { thoughts, answer };
}

/**
 * Compiles Google Provider endpoint parameters (URL, headers, request body builder)
 * supporting both Google AI Studio (API Key) and Google Cloud Vertex AI (OAuth2).
 */
export function compileGoogleEndpoint(modelModule: any): {
  url: string;
  headers: Record<string, string>;
  bodyBuilder: (systemPrompt: string, userPrompt: string) => any;
} {
  const modelName = modelModule.modelName || "gemini-2.0-flash";
  
  // Enforce Gemma 4 check
  validateGemmaModel(modelName);

  const apiKey = modelModule.apiKey || "";
  const baseUrl = modelModule.baseUrl || "";

  let url = "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  // Vertex AI Endpoint compiler
  if (baseUrl.includes("aiplatform.googleapis.com")) {
    const regionMatch = baseUrl.match(/https:\/\/([\w-]+)-aiplatform/);
    const projectMatch = baseUrl.match(/\/projects\/([\w-]+)\//);

    const region = regionMatch ? regionMatch[1] : "us-central1";
    const projectId = projectMatch ? projectMatch[1] : "crowdos-gcp-project";

    url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${modelName}:generateContent`;
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else {
    // Standard AI Studio API Key endpoint
    url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  }

  const bodyBuilder = (systemPrompt: string, userPrompt: string) => {
    const payload: any = {
      contents: [
        { role: "user", parts: [{ text: userPrompt }] }
      ],
      generationConfig: {
        temperature: modelModule.temperature ?? 0.7,
        maxOutputTokens: modelModule.maxOutputTokens ?? 2048
      }
    };

    if (systemPrompt) {
      payload.systemInstruction = {
        parts: [{ text: systemPrompt }]
      };
    }

    return payload;
  };

  return { url, headers, bodyBuilder };
}
