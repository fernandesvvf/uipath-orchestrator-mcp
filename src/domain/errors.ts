/**
 * DOMAIN ERRORS — translate transport/HTTP failures into named, LLM-readable
 * errors. The HTTP client throws these; tools catch them and surface .message
 * to the model. Named errors > raw "HTTP 401" so the agent can reason.
 */

export class UnauthorizedError extends Error {
    constructor(message = "Unauthorized: service token is missing or invalid") {
        super(message);
        this.name = "UnauthorizedError";
    }
}

export class ForbiddenError extends Error {
    constructor(message = "Forbidden: token does not have sufficient permissions") {
        super(message);
        this.name = "ForbiddenError";
    }
}

export class RateLimitError extends Error {
    constructor(message = "Rate limit exceeded. Please try again later.") {
        super(message);
        this.name = "RateLimitError";
    }
}
