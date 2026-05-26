import { GoogleGenAI } from "@google/genai";

export default async function handler(req: any, res: any) {
  // Only allow POST request
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { prompt, history, model = "gemini-3.1-flash-lite" } = req.body;
    
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY is not defined in the environment.");
      return res.status(500).json({ error: "GEMINI_API_KEY environment variable is not configured." });
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });

    // Construct Gemini contents array
    const contents = [];
    if (history && Array.isArray(history)) {
      for (const msg of history) {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        });
      }
    }
    
    contents.push({
      role: 'user',
      parts: [{ text: prompt }]
    });

    // Try requested model first, with fallbacks of fallback tree if there are any errors (like high demand 503 errors)
    let response;
    const triedModels = [
      model,
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash"
    ].filter((value, index, self) => self.indexOf(value) === index);

    let lastError = null;
    let usedModel = model;
    for (const currentModel of triedModels) {
      try {
        console.log(`Generating content using model: ${currentModel}`);
        const resGen = await ai.models.generateContent({
          model: currentModel,
          contents: contents,
          config: {
            systemInstruction: "You are a professional legal AI assistant for Kerala. Fluent in English & Malayalam."
          }
        });
        if (resGen && resGen.text) {
          response = resGen;
          usedModel = currentModel;
          break;
        }
      } catch (err: any) {
        console.warn(`Model ${currentModel} failed:`, err.message || err);
        lastError = err;
      }
    }

    if (!response) {
      throw lastError || new Error("All attempt models failed to generate content.");
    }

    const displayNameMap: { [key: string]: string } = {
      'gemini-3.5-flash': 'Gemini 3.5 Flash',
      'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite'
    };

    return res.status(200).json({ 
      text: response.text, 
      model: displayNameMap[usedModel] || usedModel
    });
  } catch (error: any) {
    console.error("Gemini API Error in Vercel Serverless Function:", error);
    return res.status(500).json({ error: error.message || "Failed to generate content from Gemini" });
  }
}
