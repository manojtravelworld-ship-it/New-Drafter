import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";


// Helper function to generate content with multiple fallback models and retries in case of high demand (503)
async function generateContentWithFallback(
  ai: GoogleGenAI,
  options: {
    contents: any;
    config?: any;
    primaryModel?: string;
  }
) {
  const models = [
    options.primaryModel || "gemini-2.5-flash",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite"
  ].filter((value, index, self) => !!value && self.indexOf(value) === index);

  let lastError = null;
  for (const modelName of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Generating content using model: ${modelName} (attempt ${attempt}/2)`);
        const response = await ai.models.generateContent({
          model: modelName,
          contents: options.contents,
          config: options.config
        });
        if (response && response.text) {
          return { response, modelUsed: modelName };
        }
      } catch (err: any) {
        console.warn(`Attempt ${attempt} for model ${modelName} failed:`, err.message || err);
        lastError = err;
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }
  }

  throw lastError || new Error("All fallback models failed to generate content.");
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Route for Gemini content generation
  app.post("/api/gemini/generate", async (req, res) => {
    try {
      const { prompt, history, model = "gemini-2.5-flash" } = req.body;
      
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

      const { response, modelUsed } = await generateContentWithFallback(ai, {
        contents,
        config: {
          systemInstruction: "You are a professional legal AI assistant for Kerala. Fluent in English & Malayalam."
        },
        primaryModel: model
      });

      const displayNameMap: { [key: string]: string } = {
        'gemini-3.5-flash': 'Gemini 3.5 Flash',
        'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
        'gemini-2.5-flash': 'Gemini 2.5 Flash',
        'gemini-2.0-flash': 'Gemini 2.0 Flash'
      };

      res.json({ 
        text: response.text, 
        model: displayNameMap[modelUsed] || modelUsed
      });
    } catch (error: any) {
      console.error("Gemini API Error:", error);
      res.status(500).json({ error: error.message || "Failed to generate content from Gemini" });
    }
  });

  // API Route for live Cortex suggestions with severity tags
  app.post("/api/gemini/suggestions", async (req, res) => {
    try {
      const { draftText } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
      });

      const prompt = `Review the following legal draft (meant for standard Indian/Kerala court format) and provide 3-5 specific suggestions for improvement.
You MUST classify each suggestion with a severity tag at the beginning of its line:
- Use [RED] for critical missing mandatory clauses, jurisdictional facts, or court fee issues in Kerala/Indian court format.
- Use [YELLOW] for weak, ambiguous, or non-standard legal language.
- Use [GREEN] for citations, historical enhancements, or optional clauses to add (e.g. Kerala Court Fees and Suits Valuation Act, CPC, Evidence Act etc).

Format each suggestion as a single line starting with the tag [RED], [YELLOW] or [GREEN]. Do not use markdown headers, just return standard bullet lines (one per suggestion, max 5 suggestions). Keep suggestions professional, actionable, and specific to the text provided.

Draft to review:
"${draftText || '[Empty Draft]'}"`;

      const { response } = await generateContentWithFallback(ai, {
        contents: prompt,
        config: {
          systemInstruction: "You are a professional legal AI assistant for Kerala. Fluent in English & Malayalam."
        },
        primaryModel: "gemini-2.5-flash"
      });

      res.json({ text: response.text || "" });
    } catch (error: any) {
      console.error("Suggestions API Error:", error);
      res.status(500).json({ error: error.message || "Failed to generate suggestions" });
    }
  });

  // API Route for Clause Standard Checker
  app.post("/api/gemini/standard-checker", async (req, res) => {
    try {
      const { clauseText, documentType } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
      });

      const prompt = `You are an expert Indian court legal standards checker specializing in Kerala High Court and sub-ordinate courts.
The advocate has submitted this clause:
"${clauseText || '[Blank clause]'}"

Document type: "${documentType || 'OS Plaint'}".

Compare it to standard Kerala/Indian court practices. You must specifically evaluate:
1. Is this standard? What crucial elements are missing?
2. Cite and argue relevant statutes, Acts, or rules (specifically naming e.g., Kerala Court Fees and Suits Valuation Act 1959, Civil Procedure Code CPC, Indian Evidence Act/Bharatiya Sakshya Act, etc.).
3. Suggest a rewritten, fully standard version of this clause.

Respond with exactly these formatted headers in Markdown:
### STATUS EVALUATION
[Briefly assess standard/non-standard and compatibility]

### STATUTORY LEGAL CRITIQUE
[Cite and critique relevant acts and rules]

### REWRITTEN RECOMMENDATION
\`\`\`text
[The complete, standard, ready-to-use version of the clause]
\`\`\``;

      const { response } = await generateContentWithFallback(ai, {
        contents: prompt,
        config: {
          systemInstruction: "You are a professional legal AI assistant for Kerala. Fluent in English & Malayalam."
        },
        primaryModel: "gemini-2.5-flash"
      });

      res.json({ text: response.text || "" });
    } catch (error: any) {
      console.error("Standard Checker API Error:", error);
      res.status(500).json({ error: error.message || "Failed to verify clause" });
    }
  });

  // API Route for Auto-Draft from Client Intake Questionnaire
  app.post("/api/gemini/auto-draft", async (req, res) => {
    try {
      const { clientName, caseType, fieldDetails, courtName } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
      });

      let caseSpecificPrompt = "";
      if (caseType === "property") {
        caseSpecificPrompt = `This is a PROPERTY LITIGATION CASE.
Survey Number/Re-Survey No: ${fieldDetails.surveyNumber || "[N/A]"}`;
        if (fieldDetails.hasEncroachment === "yes") {
          caseSpecificPrompt += `\n- Encroachment occurred on: ${fieldDetails.encroachmentDate || "[N/A]"}
- Affected Property boundaries and details: ${fieldDetails.boundaries || "[N/A]"}`;
        } else {
          caseSpecificPrompt += `\n- Encroachment: None specified (Dispute over general title / easement rights).`;
        }
        if (fieldDetails.hasRegisteredDeed === "yes") {
          caseSpecificPrompt += `\n- Property is registered under Deed Number: ${fieldDetails.deedNumber || "[N/A]"} at SRO Name: ${fieldDetails.sroName || "[N/A]"}`;
        } else {
          caseSpecificPrompt += `\n- Registered Deed Details: Unregistered or general claim.`;
        }
      } else if (caseType === "criminal") {
        caseSpecificPrompt = `This is a CRIMINAL DEFENSE CASE.
FIR Number: ${fieldDetails.firNumber || "[N/A]"}
Police Station Jurisdiction: ${fieldDetails.policeStation || "[N/A]"}
Sections Charged: ${fieldDetails.sectionCharged || "[N/A]"}`;
        if (fieldDetails.isBailable === "no") {
          caseSpecificPrompt += `\n- The offense is classified as NON-BAILABLE.
- Remand custody date: ${fieldDetails.remandDate || "[N/A]"}
- Confined jail location / name: ${fieldDetails.jailName || "[N/A]"}`;
        } else {
          caseSpecificPrompt += `\n- The offense is classified as BAILABLE. client is presently on bail.`;
        }
      } else {
        caseSpecificPrompt = `This is a general legal dispute or other civil matter.`;
      }

      const prompt = `You are a prestigious legal draftsman in Kerala.
Please pre-populate the introductory Pleadings / Page 1 of the lawsuit in Indian Court format.
Generate the draft for client "${clientName}" in the court "${courtName || 'MUNSIFF COURT OF ERNAKULAM'}".
Include all of the following specific field details directly inside the relevant paragraphs of the pleadings:
- Case Title details
- Parties description
- ${caseSpecificPrompt}

Use highly formal legal terminology, structured sections, proper court headers, and Indian court pleading style. Do NOT leave fields blank, write them into the narrative in professional format. Include a cause of action section and a formal court jurisdiction assertion.

Draft output should be complete text, court-ready, and starting with proper Indian Court designation headers.`;

      const { response } = await generateContentWithFallback(ai, {
        contents: prompt,
        config: {
          systemInstruction: "You are a professional legal AI assistant for Kerala. Fluent in English & Malayalam."
        },
        primaryModel: "gemini-2.5-flash"
      });

      res.json({ text: response.text || "" });
    } catch (error: any) {
      console.error("Auto-Draft API Error:", error);
      res.status(500).json({ error: error.message || "Failed to generate auto-draft" });
    }
  });

  // API Route for [F06] Court Order auto-extraction
  app.post("/api/gemini/extract-order", async (req, res) => {
    try {
      const { orderText } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
      });

      const prompt = `This is a scanned / OCR copy of an Indian/Kerala court order or legal document:
"${orderText || '[No text provided]'}"

Analyze this text and extract:
1. "hearing_date": The next hearing / posting date. Convert to "YYYY-MM-DD" format. If the year is ambiguous, assume 2026. If the year is '25' or '2025', convert to 2026 as per our standard timelines.
2. "court_name": The exact name of the court or venue (e.g. "Munsiff Court, Aluva" or "District Court, Ernakulam" or "Sub Judicial Magistrate, Kochi").
3. "case_number": The case index/number (e.g. "OS 145/2026", "CC 445/2026").
4. "directive": The purpose of posting / directive / next step (e.g. "Filing Written Statement", "Appearance", "Suit for Recovery").

Respond with ONLY a raw valid JSON object. Do not include markdown code block syntax (like \`\`\`json) or any other text outside the JSON object itself.
Strict Schema:
{
  "hearing_date": "YYYY-MM-DD or empty string",
  "court_name": "extracted court name or empty string",
  "case_number": "extracted case number or empty string",
  "directive": "extracted directive/purpose or empty string"
}`;

      const { response } = await generateContentWithFallback(ai, {
        contents: prompt,
        config: {
          systemInstruction: "You are a precise data extractor tool. Output raw JSON ONLY."
        },
        primaryModel: "gemini-2.1-flash"
      });

      let text = response.text || "{}";
      text = text.replace(/```json/gi, "").replace(/```/gi, "").trim();
      const startIdx = text.indexOf('{');
      const endIdx = text.lastIndexOf('}');
      if (startIdx !== -1 && endIdx !== -1) {
        text = text.slice(startIdx, endIdx + 1);
      }
      
      const resultObj = JSON.parse(text);
      res.json(resultObj);
    } catch (error: any) {
      console.error("Extract Order API Error:", error);
      res.status(500).json({ error: error.message || "Failed to extract court order details." });
    }
  });

  // API Route for [F07] Malayalam WhatsApp client update drafter
  app.post("/api/gemini/whatsapp-draft", async (req, res) => {
    try {
      const { name, caseNo, court, date, purpose } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
      });

      const prompt = `Draft a brief WhatsApp message in Malayalam to client ${name} for case ${caseNo} at ${court} on ${date} for ${purpose}.
Include professional greeting, case details, venue court, next hearing/posting date, purpose, and a request to prepare. Keep it polite, clear, and written in readable Malayalam script (use Malayalam alphabet). Ensure it's ready to be sent on WhatsApp (use bold text e.g. *bold* for critical items and warm/constructive greeting). Do not include any extra introductory text. Just output the drafted Malayalam WhatsApp message.`;

      const { response } = await generateContentWithFallback(ai, {
        contents: prompt,
        config: {
          systemInstruction: "You are a professional legal assistant fluent in Malayalam."
        },
        primaryModel: "gemini-2.5-flash"
      });

      res.json({ draft: response.text || "" });
    } catch (error: any) {
      console.error("WhatsApp Draft Error:", error);
      res.status(500).json({ error: error.message || "Failed to generate Malayalam WhatsApp update." });
    }
  });

  // API Route for [F09] Reading Room document summarizer
  app.post("/api/gemini/summarise-doc", async (req, res) => {
    try {
      const { docText } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
      });

      const prompt = `This is a scanned Indian legal document text:
"${docText || '[No text provided]'}"

Summarise in exactly 4 bullet points:
- Document Type: [A short description of the document classification]
- Parties: [Key individuals, plaintiffs, defendants, or state involved]
- Key Dates: [Any critical dates, hearing dates, or filing dates specified]
- Action Required: [The next immediate legal step or directive specified]

Keep the output extremely professional, precise, and structured under these 4 labels.`;

      const { response } = await generateContentWithFallback(ai, {
        contents: prompt,
        config: {
          systemInstruction: "You are a professional legal summary AI assistant for India."
        },
        primaryModel: "gemini-2.5-flash"
      });

      res.json({ summary: response.text || "" });
    } catch (error: any) {
      console.error("Summarise Doc Error:", error);
      res.status(500).json({ error: error.message || "Failed to generate document summary." });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
