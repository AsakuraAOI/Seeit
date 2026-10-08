import type {
  ASRProvider,
  ASRRequest,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  VisionClipAnalysisRequest,
  VisionImageAnalysisRequest,
  VisionProvider,
} from "./interfaces.js";
import type {
  SubtitleCue,
  Transcript,
  VisualObservation,
} from "../core/types.js";

/** Lightweight adapter useful when wiring a real provider at an application edge. */
export class FunctionLLMProvider implements LLMProvider {
  public constructor(
    private readonly handler: <T = string>(
      request: LLMRequest,
    ) => Promise<LLMResponse<T>>,
  ) {}

  generate<T = string>(request: LLMRequest): Promise<LLMResponse<T>> {
    return this.handler<T>(request);
  }
}

/** Lightweight adapter useful when wiring a real provider at an application edge. */
export class FunctionVisionProvider implements VisionProvider {
  public readonly analyzeClip?: (
    request: VisionClipAnalysisRequest,
  ) => Promise<VisualObservation>;

  public constructor(
    private readonly imageHandler: (
      request: VisionImageAnalysisRequest,
    ) => Promise<VisualObservation>,
    clipHandler?: (
      request: VisionClipAnalysisRequest,
    ) => Promise<VisualObservation>,
  ) {
    if (clipHandler) this.analyzeClip = clipHandler;
  }

  analyzeImages(
    request: VisionImageAnalysisRequest,
  ): Promise<VisualObservation> {
    return this.imageHandler(request);
  }

}

/** Lightweight adapter useful when wiring a real ASR provider at an application edge. */
export class FunctionASRProvider implements ASRProvider {
  public constructor(
    private readonly handler: (
      request: ASRRequest,
    ) => Promise<Transcript | SubtitleCue[]>,
  ) {}

  transcribe(request: ASRRequest): Promise<Transcript | SubtitleCue[]> {
    return this.handler(request);
  }
}

/**
 * Deterministic test provider.  It records requests and returns either one
 * fixed result or the next result from a supplied queue.
 */
export class FakeLLMProvider implements LLMProvider {
  public readonly requests: LLMRequest[] = [];

  private readonly queued: LLMResponse<unknown>[];

  public constructor(
    responses: readonly LLMResponse<unknown>[] | LLMResponse<unknown> = {
      text: "",
    },
  ) {
    this.queued = Array.isArray(responses) ? [...responses] : [responses];
  }

  async generate<T = string>(request: LLMRequest): Promise<LLMResponse<T>> {
    this.requests.push(request);
    const response = this.queued[Math.min(this.requests.length - 1, this.queued.length - 1)];
    if (!response) {
      throw new Error("FakeLLMProvider has no configured response.");
    }
    return response as LLMResponse<T>;
  }
}

export class FakeVisionProvider implements VisionProvider {
  public readonly imageRequests: VisionImageAnalysisRequest[] = [];
  public readonly clipRequests: VisionClipAnalysisRequest[] = [];
  public readonly analyzeClip?: (
    request: VisionClipAnalysisRequest,
  ) => Promise<VisualObservation>;

  private readonly imageResults: VisualObservation[];

  public constructor(options: {
    images: readonly VisualObservation[] | VisualObservation;
    clips?: readonly VisualObservation[] | VisualObservation;
  }) {
    this.imageResults = Array.isArray(options.images)
      ? [...options.images]
      : [options.images];
    if (options.clips) {
      const clipResults = Array.isArray(options.clips)
        ? [...options.clips]
        : [options.clips];
      this.analyzeClip = async (request) => {
        this.clipRequests.push(request);
        return this.resultAt(clipResults, this.clipRequests.length - 1, "clip");
      };
    }
  }

  async analyzeImages(
    request: VisionImageAnalysisRequest,
  ): Promise<VisualObservation> {
    this.imageRequests.push(request);
    return this.resultAt(this.imageResults, this.imageRequests.length - 1, "image");
  }

  private resultAt(
    results: readonly VisualObservation[],
    index: number,
    kind: string,
  ): VisualObservation {
    const result = results[Math.min(index, results.length - 1)];
    if (!result) {
      throw new Error(`FakeVisionProvider has no configured ${kind} result.`);
    }
    return result;
  }
}

export class FakeASRProvider implements ASRProvider {
  public readonly requests: ASRRequest[] = [];

  public constructor(
    private readonly result: Transcript | SubtitleCue[] | ((request: ASRRequest) => Transcript | SubtitleCue[] | Promise<Transcript | SubtitleCue[]>),
  ) {}

  async transcribe(request: ASRRequest): Promise<Transcript | SubtitleCue[]> {
    this.requests.push(request);
    if (typeof this.result === "function") {
      return this.result(request);
    }
    return this.result;
  }
}
