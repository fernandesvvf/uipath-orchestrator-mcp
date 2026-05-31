/**
 * AUTH — abstraction over "how do we authenticate to the backend".
 *
 * The MCP is a THIN ADAPTER: real auth lives in the backend API (aula 07).
 * Here we only decide which headers to attach. Bearer is the default (matches
 * the course); swap the impl if your API uses an API key, basic auth, etc.
 */

export interface AuthProvider {
    /** Headers merged into every outgoing request. */
    headers(): Record<string, string>;
}

export class BearerAuth implements AuthProvider {
    #token: string;
    constructor(token: string) {
        if (!token) throw new Error("BearerAuth requires a non-empty token");
        this.#token = token;
    }
    headers(): Record<string, string> {
        return { Authorization: `Bearer ${this.#token}` };
    }
}

/** No auth — handy for local/dev backends. */
export class NoAuth implements AuthProvider {
    headers(): Record<string, string> {
        return {};
    }
}
