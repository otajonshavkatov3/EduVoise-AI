export type Sentiment = "positive" | "neutral" | "negative";

/** PATCH /ai-analyses/{id}. Null — maydonni tozalash, undefined — tegmaslik. */
export interface UpdateAiAnalysisRequest {
	summary?: string | null;
	sentiment?: Sentiment | null;
	categories?: string[] | null;
}

/**
 * Qo'lda tuzatish izi. `GET /ai-analyses/{id}` uni audit loglardan yig'adi —
 * `ai_analyses` jadvalida bunday ustun yo'q.
 */
export interface AnalysisCorrection {
	at: string;
	byUserId: string | null;
	byPhone: string | null;
}
