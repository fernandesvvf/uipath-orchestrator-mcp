import { describe, it } from "node:test";
import assert from "node:assert";
import { RateLimiter } from "../src/mcp/middleware/rate-limiter.ts";
import { RateLimitError } from "../src/domain/errors.ts";

/**
 * UNIT test — no backend needed. The rate limiter is pure logic, so it's the
 * cheapest thing to test. Run with: npm test (matches tests/**\/*.test.ts).
 */
describe("RateLimiter (token bucket)", () => {
    it("allows up to capacity in a burst", () => {
        const limiter = new RateLimiter(3, 1);
        assert.doesNotThrow(() => limiter.take());
        assert.doesNotThrow(() => limiter.take());
        assert.doesNotThrow(() => limiter.take());
    });

    it("throws RateLimitError when the bucket is empty", () => {
        const limiter = new RateLimiter(2, 1);
        limiter.take();
        limiter.take();
        assert.throws(() => limiter.take(), RateLimitError);
    });

    it("refills over time", async () => {
        const limiter = new RateLimiter(1, 50); // 50 tokens/sec -> ~20ms each
        limiter.take();
        assert.throws(() => limiter.take(), RateLimitError);
        await new Promise((r) => setTimeout(r, 60));
        assert.doesNotThrow(() => limiter.take());
    });
});
