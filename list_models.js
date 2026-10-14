// Lists the Gemini models your API key can actually reach.
// Usage: GEMINI_API_KEY=... node list_models.js
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Set GEMINI_API_KEY in your environment (see .env.example) before running this.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

const models = await ai.models.list();
for await (const model of models) {
  const methods = model.supportedGenerationMethods || [];
  if (!methods.includes("generateContent")) continue;
  console.log(`${model.name.replace("models/", "").padEnd(46)} ${model.displayName || ""}`);
}
