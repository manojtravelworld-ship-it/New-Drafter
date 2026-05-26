/**
 * Nexus AI Engine
 * ───────────────────────────────────────────────────────────────
 * Brain1 — PRIMARY   : Gemma 4 E2B  via wllama (WASM/CPU)
 *                      Works on ANY phone — no WebGPU needed
 *                      Source: manojbillionaire123/gemma-4-E2B-it-GGUF
 *                      File  : gemma-4-E2B-it-Q3_K_M.gguf  (~1.2 GB)
 *
 * Brain2 — SECONDARY : Gemma 4 E4B      via wllama (WASM/CPU)
 *                      Powerful reasoning for complex legal drafting
 *                      Source: manojbillionaire123/gemma-4-E4B-it-GGUF
 *                      File  : gemma-4-E4B-it-Q3_K_M.gguf  (~2.1 GB)
 *
 * User can download Brain1, Brain2, or both independently.
 * Active engine = Brain1 if loaded, else Brain2 if loaded, else offline.
 * ───────────────────────────────────────────────────────────────
 */

import { Wllama } from '@wllama/wllama';
import { ParallelDownloader } from './parallel-downloader';

// Polyfill Blob.stream (mandatory for wllama URL/Blob handling in some browsers)
if (typeof Blob !== 'undefined' && !Blob.prototype.stream) {
  (Blob.prototype as any).stream = function() {
    return new Response(this).body;
  };
}

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
}

export interface AIResponse {
  text: string;
  model: string;
}

export type AITaskType = 'voice' | 'drafting' | 'search' | 'general';

/**
 * Streaming-safe function to remove any <think>...</think> content.
 * Prevents leaking partial tags at the end of stream chunks.
 */
export function cleanStreamingText(rawText: string): string {
  let activeText = rawText;

  // List of markers we want to prevent leaking or being printed
  const stopMarkers = [
    '<start_of_turn>',
    '<end_of_turn>',
    '<|im_start|>',
    '<||im_end|>',
    '<|im_end|>',
    'user\n',
    'model\n',
    'assistant\n',
    'system\n'
  ];

  // If a token is partially written at the end, let's defer yielding it
  const lastLt = rawText.lastIndexOf('<');
  if (lastLt !== -1) {
    const tail = rawText.substring(lastLt).toLowerCase();
    const isPartialToken = stopMarkers.some(t => t.toLowerCase().startsWith(tail)) || 
                          '<think>'.startsWith(tail) || 
                          '</think>'.startsWith(tail);
    if (isPartialToken) {
      activeText = rawText.substring(0, lastLt);
    }
  }

  // Remove full occurrences of thinking tags and control tags
  let result = activeText;
  
  // Remove <think>...</think>
  const lower = result.toLowerCase();
  let inThink = false;
  let cleaned = "";
  let i = 0;
  while (i < result.length) {
    if (!inThink) {
      if (lower.indexOf('<think>', i) === i) {
        inThink = true;
        i += 7;
      } else {
        cleaned += result[i];
        i++;
      }
    } else {
      if (lower.indexOf('</think>', i) === i) {
        inThink = false;
        i += 8;
      } else {
        i++;
      }
    }
  }
  
  result = cleaned;

  // Truncate at any leftover stop tokens to prevent trailing garbage
  for (const marker of stopMarkers) {
    const idx = result.indexOf(marker);
    if (idx !== -1) {
      result = result.substring(0, idx);
    }
  }

  return result;
}

// ── Model config ──────────────────────────────────────────────

const BRAIN1_REPO  = 'manojbillionaire123/gemma-4-E2B-it-GGUF';
const BRAIN1_FILE  = 'gemma-4-E2B-it-Q3_K_M.gguf';
const BRAIN1_LABEL = 'Nexus Gemma 4 E2B';
const BRAIN1_SIZE  = '~1.2 GB';

const BRAIN2_REPO  = 'manojbillionaire123/gemma-4-E4B-it-GGUF';
const BRAIN2_FILE  = 'gemma-4-E4B-it-Q3_K_M.gguf';
const BRAIN2_LABEL = 'Nexus Gemma 4 E4B';
const BRAIN2_SIZE  = '~2.1 GB';

// wllama WASM paths (served from /wllama/ in public/)
const WLLAMA_CONFIG: any = {
  'default': '/wllama/wllama.wasm',
};

const SYSTEM_PROMPT = `You are Nexus Justice, a professional legal AI assistant for Kerala.
Fluent in English & Malayalam.
RULES:
1. AUTO-DETECT: Respond in the language used by the user.
2. MALAYALAM: If user asks in Malayalam, answer in Malayalam characters.
3. SPEED: Keep voice answers very short (<40 words). Be direct.
4. BRAIN: Use Brain1 for speed.`;

// ── Engine class ──────────────────────────────────────────────

export class HybridAIEngine {
  private static instance: HybridAIEngine;

  // Each brain gets its own wllama instance
  private brain1: Wllama | null = null;
  private brain2: Wllama | null = null;
  private activeBrainPreference: 'brain1' | 'brain2' = 'brain1';

  private brain1Loading  = false;
  private brain2Loading  = false;
  private brain1Progress = 0;
  private brain2Progress = 0;
  private brain1Ready    = false;
  private brain2Ready    = false;
  private brain1Message  = `${BRAIN1_LABEL} · ${BRAIN1_SIZE} · Q4_K_M`;
  private brain2Message  = `${BRAIN2_LABEL} · ${BRAIN2_SIZE} · Q3_K_M`;

  private inferenceLock: Record<string, boolean> = { brain1: false, brain2: false };

  private constructor() {
    console.log('Nexus AI Engine ready (wllama/CPU — no WebGPU required)');
  }

  public static getInstance(): HybridAIEngine {
    if (!HybridAIEngine.instance) {
      HybridAIEngine.instance = new HybridAIEngine();
    }
    return HybridAIEngine.instance;
  }

  // ── Active engine ─────────────────────────────────────────

  public setActiveBrain(brain: 'brain1' | 'brain2') {
    this.activeBrainPreference = brain;
    console.log(`Neural Preference switched to: ${brain}`);
  }

  private get activeEngine(): Wllama | null {
    if (this.activeBrainPreference === 'brain2' && this.brain2) return this.brain2;
    if (this.brain1) return this.brain1;
    return this.brain2; // Fallback
  }

  private get activeModelName(): string {
    const engine = this.activeEngine;
    if (engine === this.brain1 && this.brain1) return BRAIN1_LABEL;
    if (engine === this.brain2 && this.brain2) return BRAIN2_LABEL;
    return 'Offline';
  }

  // ── Status (used by UI) ───────────────────────────────────

  public getStatus() {
    return {
      builtIn:         false,
      isLocalReady:    !!this.activeEngine,
      voiceModel:      this.activeEngine ? this.activeModelName : 'Not loaded',
      draftModel:      this.activeEngine ? this.activeModelName : 'Not loaded',
      searchModel:     'Local Neural Index',
      loadProgress:    this.brain1Progress,
      activeBrain:     this.activeBrainPreference,
      // Brain1
      isBrain1Ready:   this.brain1Ready,
      brain1Progress:  this.brain1Progress,
      brain1Model:     BRAIN1_LABEL,
      brain1Message:   this.brain1Message,
      isBrain1Loading: this.brain1Loading,
      // Brain2
      isBrain2Ready:   this.brain2Ready,
      brain2Progress:  this.brain2Progress,
      brain2Model:     BRAIN2_LABEL,
      brain2Message:   this.brain2Message,
      isBrain2Loading: this.brain2Loading,
      // TTS/STT (Web Speech — always ready)
      ttsReady:        true,
      sttReady:        true,
      ttsProgress:     100,
      sttProgress:     100,
      isTTSLoading:    false,
      isSTTLoading:    false,
    };
  }

  private async createWllama(): Promise<Wllama> {
    console.log('Initializing Nexus Neural Pipeline with unified wllama.wasm.');
    
    const config: any = {
      ...WLLAMA_CONFIG,
    };

    console.log('Final Neural Config:', config);
    const w = new Wllama(config);
    
    try {
      if (w.cacheManager) {
        console.log('Wllama Neural Cache Manager active');
      }
    } catch (e) {
      console.warn('Neural Cache failed to init:', e);
    }

    console.log('Neural Instance created successfully');
    return w;
  }

  /** Load Brain1 — Gemma 4 E2B Q3_K_M (primary, ~1.2 GB) */
  public async loadBrain1(
    onProgress?: (progress: number, text: string) => void,
    force = false
  ) {
    if ((this.brain1Ready && !force) || this.brain1Loading) return;
    if (force && this.brain1) {
      await this.brain1.exit().catch(() => {});
      this.brain1 = null;
      this.brain1Ready = false;
      this.brain1Progress = 0;
    }

    this.brain1Loading = true;
    this.brain1Message = '⚙️ NEXUS CORE: Initializing Neural Engine...';
    try {
      const isSABSupported = typeof SharedArrayBuffer !== 'undefined';
      
      this.brain1Message = '📡 Parallel Engine: Connecting to Neural LFS...';
      const modelUrl = `https://huggingface.co/${BRAIN1_REPO}/resolve/main/${BRAIN1_FILE}?download=true`;
      
      const blob = await ParallelDownloader.download(
        modelUrl,
        BRAIN1_FILE, 
        3, 
        (pct, loaded, total) => {
          this.brain1Progress = pct;
          const text = pct < 100 
            ? (total > 0 
                ? `📥 Fast-Download: ${pct}% (${Math.round(loaded / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`
                : `📥 Fast-Download: ${Math.round(loaded / 1024 / 1024)}MB...`)
            : `🔍 Neural Core: Running CPU Optimization...`;
          this.brain1Message = text;
          onProgress?.(pct, text);
        }
      );

      const w = await this.createWllama();
      await w.loadModel(
        [blob],
        {
          n_ctx: 2048,
          n_batch: 32,
          n_threads: isSABSupported ? Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1) : 1,
        }
      );
      this.brain1 = w;
      this.brain1Ready = true;
      this.brain1Progress = 100;
      this.brain1Message = `✅ ${BRAIN1_LABEL} ready · CPU/WASM${!isSABSupported ? ' (Slow Mode)' : ''}`;
      onProgress?.(100, this.brain1Message);
    } catch (err) {
      console.error('Brain1 load failed:', err);
      this.brain1Message = `⚠️ Brain1 load failed: ${(err as Error).message}`;
      this.brain1 = null;
      this.brain1Ready = false;
      onProgress?.(0, this.brain1Message);
    } finally {
      this.brain1Loading = false;
    }
  }

  /** Load Brain2 — Gemma-4 E4B (secondary, ~2.1 GB) */
  public async loadBrain2(
    onProgress?: (progress: number, text: string) => void,
    force = false
  ) {
    if ((this.brain2Ready && !force) || this.brain2Loading) return;
    if (force && this.brain2) {
      await this.brain2.exit().catch(() => {});
      this.brain2 = null;
      this.brain2Ready = false;
      this.brain2Progress = 0;
    }

    this.brain2Loading = true;
    this.brain2Message = '⚙️ NEXUS CORE: Initializing Neural Engine...';
    try {
      const isSABSupported = typeof SharedArrayBuffer !== 'undefined';
      
      const modelUrl = `https://huggingface.co/${BRAIN2_REPO}/resolve/main/${BRAIN2_FILE}?download=true`;
      
      this.brain2Message = '📡 Neural-LFS: Connecting to high-speed model pipe...';
      const blob = await ParallelDownloader.download(
        modelUrl,
        BRAIN2_FILE, 
        3, 
        (pct, loaded, total) => {
          this.brain2Progress = pct;
          const text = pct < 100 
            ? `📥 Neural-LFS: ${pct}% (${Math.round(loaded / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`
            : `🔍 Neural Core: Finalizing 4B Matrix Optimization...`;
          this.brain2Message = text;
          onProgress?.(pct, text);
        }
      );

      const w = await this.createWllama();
      await w.loadModel([blob], {
        n_ctx: 4096,
        n_batch: 32,
        n_threads: isSABSupported ? Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1) : 1,
      });

      this.brain2 = w;
      this.brain2Ready = true;
      this.brain2Progress = 100;
      this.brain2Message = `✅ ${BRAIN2_LABEL} ready · CPU/WASM${!isSABSupported ? ' (Slow Mode)' : ''}`;
      onProgress?.(100, this.brain2Message);
    } catch (err) {
      console.error('Brain2 load failed:', err);
      this.brain2Message = `⚠️ Brain2 load failed: ${(err as Error).message}`;
      this.brain2 = null;
      this.brain2Ready = false;
      onProgress?.(0, this.brain2Message);
    } finally {
      this.brain2Loading = false;
    }
  }

  public async loadTTS(onProgress?: (p: number) => void) { onProgress?.(100); }
  public async loadSTT(onProgress?: (p: number) => void) { onProgress?.(100); }

  private buildPrompt(userMessage: string, history: AIMessage[]): string {
    const recent = history.slice(-4);
    let prompt = `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n`;
    for (const m of recent) {
      const role = m.role === 'user' ? 'user' : 'assistant';
      prompt += `<|im_start|>${role}\n${m.content}<|im_end|>\n`;
    }
    prompt += `<|im_start|>user\n${userMessage}<|im_end|>\n<|im_start|>assistant\n`;
    return prompt;
  }

  private async callGeminiAPI(
    prompt: string,
    history: AIMessage[]
  ): Promise<AIResponse> {
    try {
      const response = await fetch("/api/gemini/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          history,
          model: "gemini-3.1-flash-lite"
        })
      });
      if (!response.ok) {
        throw new Error(`Gemini remote returned HTTP ${response.status}`);
      }
      const data = await response.json();
      return {
        text: data.text || "No response generated.",
        model: data.model || "Gemini 3.1 Flash-Lite"
      };
    } catch (err: any) {
      console.error("Gemini call failed:", err);
      throw err;
    }
  }

  public async *generateResponseStream(
    prompt: string,
    history: AIMessage[],
    task: AITaskType = 'voice'
  ): AsyncGenerator<{ text: string; model: string; status?: string }> {
    yield { text: '', model: 'Gemini 3.1 Flash-Lite', status: 'Connecting to Gemini Cloud...' };

    try {
      // 1. Primary: Gemini 3.1 Flash-Lite
      const geminiRes = await this.callGeminiAPI(prompt, history);
      yield { text: geminiRes.text, model: geminiRes.model || 'Gemini 3.1 Flash-Lite' };
      return;
    } catch (err: any) {
      console.warn("Gemini Primary failed. Attempting Fallback to Local Neural Core...", err);

      // 2. Fallback: Local Engine
      const engine = this.activeEngine;
      const modelName = this.activeModelName;
      const lockKey = engine === this.brain1 ? 'brain1' : 'brain2';

      if (!engine) {
        yield {
          text: `⚠️ Gemini Cloud is unavailable and no local model is loaded to serve as a fallback.\n\nPlease check your internet connection or download a Nexus Brain in the 'Brains' tab to work fully offline.`,
          model: 'System'
        };
        return;
      }

      yield { text: '', model: modelName, status: `Gemini offline. Falling back to local ${modelName}...` };

      if (this.inferenceLock[lockKey]) {
        yield { text: '', model: modelName, status: 'Waiting for neural queue...' };
        while (this.inferenceLock[lockKey]) await new Promise(r => setTimeout(r, 100));
      }
      this.inferenceLock[lockKey] = true;

      try {
        const maxTokens  = task === 'voice' ? 80 : 256;
        const limit = lockKey === 'brain2' ? 4096 : 2048;
        const maxAllowedChars = Math.floor((limit - maxTokens - 100) * 3.5);

        let activePrompt = prompt;
        let activeHistory = history;

        if (activePrompt.length > maxAllowedChars) {
          console.warn(`Prompt is too long for local fallback (${activePrompt.length} chars). Truncating client draft for compatibility.`);
          activePrompt = activePrompt.substring(0, maxAllowedChars) + "\n\n...[Content truncated for offline CPU memory limits]...";
          activeHistory = [];
        } else if ((activePrompt.length + JSON.stringify(activeHistory).length) > maxAllowedChars) {
          activeHistory = activeHistory.slice(-1);
        }

        const fullPrompt = this.buildPrompt(activePrompt, activeHistory);

        const stream = await engine.createCompletion({
          prompt: fullPrompt,
          max_tokens: maxTokens,
          temp: 0.1,
          penalty_repeat: 1.1,
          stream: true,
          stop: ['<end_of_turn>', '<start_of_turn>', '<|im_end|>', '<|im_start|>', '<think>', '</think>'],
          onData: () => {},
        }) as any;

        let accumulatedRaw = "";
        let accumulatedClean = "";

        for await (const chunk of stream) {
          const delta = chunk?.choices?.[0]?.text;
          if (delta) {
            accumulatedRaw += delta;
            
            const currentClean = cleanStreamingText(accumulatedRaw);
            const cleanDelta = currentClean.substring(accumulatedClean.length);
            
            if (cleanDelta) {
              accumulatedClean = currentClean;
              yield { text: cleanDelta, model: `${modelName} (Fallback)` };
            }
          }
        }

        const finalClean = cleanStreamingText(accumulatedRaw);
        const finalDelta = finalClean.substring(accumulatedClean.length);
        if (finalDelta) {
          yield { text: finalDelta, model: `${modelName} (Fallback)` };
        }
      } catch (localErr: any) {
        console.error("Local fallback execution failed:", localErr);
        yield {
          text: `⚠️ Local fallback failed: ${localErr.message}`,
          model: 'System'
        };
      } finally {
        this.inferenceLock[lockKey] = false;
      }
    }
  }

  public async generateResponse(
    prompt: string,
    history: AIMessage[],
    _imageBase64?: string,
    task: AITaskType = 'general'
  ): Promise<AIResponse> {
    try {
      // 1. Primary: Gemini 3.1 Flash-Lite
      console.log("Routing response request to Gemini (Primary)...");
      return await this.callGeminiAPI(prompt, history);
    } catch (err: any) {
      console.warn("Gemini Primary call failed. Falling back to Local Neural Core...", err);

      // 2. Fallback: Local Engine
      const engine = this.activeEngine;
      const modelName = this.activeModelName;

      if (!engine) {
        return {
          text: `⚠️ Connection to Gemini Cloud failed and no offline model is loaded as fallback.\n\nError: ${err.message}`,
          model: 'System error'
        };
      }

      const lockKey = engine === this.brain1 ? 'brain1' : 'brain2';
      if (this.inferenceLock[lockKey]) {
        while (this.inferenceLock[lockKey]) await new Promise(r => setTimeout(r, 100));
      }
      this.inferenceLock[lockKey] = true;

      try {
        const maxTokens  = task === 'voice' ? 150 : 512;
        const limit = lockKey === 'brain2' ? 4096 : 2048;
        const maxAllowedChars = Math.floor((limit - maxTokens - 100) * 3.5);

        let activePrompt = prompt;
        let activeHistory = history;

        if (activePrompt.length > maxAllowedChars) {
          console.warn(`Prompt is too long for local fallback (${activePrompt.length} chars). Truncating client draft for compatibility.`);
          activePrompt = activePrompt.substring(0, maxAllowedChars) + "\n\n...[Content truncated for offline CPU memory limits]...";
          activeHistory = [];
        } else if ((activePrompt.length + JSON.stringify(activeHistory).length) > maxAllowedChars) {
          activeHistory = activeHistory.slice(-1);
        }

        const fullPrompt = this.buildPrompt(activePrompt, activeHistory);

        const result = await engine.createCompletion({
          prompt: fullPrompt,
          max_tokens: maxTokens,
          temp: 0.6,
          penalty_repeat: 1.1,
          stop: ['<end_of_turn>', '<start_of_turn>', '<|im_end|>', '<|im_start|>', '<think>', '</think>'],
        });
        const response = result as any;
        const rawText = response.choices?.[0]?.text || '';
        const text = cleanStreamingText(rawText).trim();
        return { text: text, model: `${modelName} (Fallback)` };
      } catch (localErr: any) {
        console.error("Local fallback inference failed:", localErr);
        return {
          text: `⚠️ Local fallback inference failed: ${localErr.message}`,
          model: 'System error'
        };
      } finally {
        this.inferenceLock[lockKey] = false;
      }
    }
  }

  public async generateGemmaTTS(_text: string, _lang = 'ml-IN'): Promise<string | null> { return null; }
}

export const aiEngine = HybridAIEngine.getInstance();
