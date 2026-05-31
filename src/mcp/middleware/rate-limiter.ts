import { RateLimitError } from "../../domain/errors.ts";

/**
 * CLIENT-SIDE RATE LIMITER (token bucket).
 *
 * Why: the backend already rate-limits (aula 07, @fastify/rate-limit). This is
 * a SECOND guard inside the MCP so a runaway agent loop is throttled BEFORE it
 * hammers the network — cheaper, faster feedback, and it throws the same
 * domain RateLimitError so tools handle it identically to a backend 429.
 *
 * Token bucket: `capacity` tokens, refilled at `refillPerSec`. Each call spends
 * one. Empty bucket -> throw. Bursts up to `capacity` allowed; sustained rate
 * capped at refillPerSec.
 */
export class RateLimiter {
    #tokens: number;
    #lastRefill: number;
    #capacity: number;
    #refillPerSec: number;

    constructor(capacity: number, refillPerSec: number) {
        if (capacity <= 0) throw new Error("capacity must be > 0");
        if (refillPerSec <= 0) throw new Error("refillPerSec must be > 0");
        this.#capacity = capacity;
        this.#refillPerSec = refillPerSec;
        this.#tokens = capacity;
        this.#lastRefill = Date.now();
    }

    #refill(): void {
        const now = Date.now();
        const elapsedSec = (now - this.#lastRefill) / 1000;
        if (elapsedSec <= 0) return;
        this.#tokens = Math.min(this.#capacity, this.#tokens + elapsedSec * this.#refillPerSec);
        this.#lastRefill = now;
    }

    /** Consume one token or throw RateLimitError. Call at the start of each request. */
    take(): void {
        this.#refill();
        if (this.#tokens < 1) {
            throw new RateLimitError(
                "Rate limit exceeded (client-side). Please slow down and try again later.",
            );
        }
        this.#tokens -= 1;
    }
}

/** Build a limiter from env, with sane defaults. */
export function rateLimiterFromEnv(): RateLimiter {
    const capacity = Number(process.env.RATE_LIMIT_BURST ?? 20);
    const refillPerSec = Number(process.env.RATE_LIMIT_PER_SEC ?? 5);
    return new RateLimiter(capacity, refillPerSec);
}
