import { afterEach, describe, expect, it } from "vitest";
import { isAuthorised } from "./guard";

const SECRET = "test-secret-value";
const URL_ = "https://app.example.com/api/v2/tick";

function request(headers: Record<string, string> = {}, url = URL_): Request {
  return new Request(url, { method: "POST", headers });
}

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("isAuthorised", () => {
  it("is open when no secret is configured", () => {
    expect(isAuthorised(request())).toBe(true);
  });

  describe("with a secret configured", () => {
    const withSecret = <T>(run: () => T): T => {
      process.env.CRON_SECRET = SECRET;
      return run();
    };

    it("accepts the bearer token an external scheduler sends", () => {
      withSecret(() => {
        expect(isAuthorised(request({ authorization: `Bearer ${SECRET}` }))).toBe(true);
      });
    });

    it("accepts the secret as a query parameter", () => {
      withSecret(() => {
        expect(isAuthorised(request({}, `${URL_}?secret=${SECRET}`))).toBe(true);
      });
    });

    it("rejects a wrong secret", () => {
      withSecret(() => {
        expect(isAuthorised(request({ authorization: "Bearer wrong" }))).toBe(false);
      });
    });

    /**
     * The regression this exists for: with a secret set, every tick the
     * dashboard sent came back 401, so the engine never ran and the UI showed
     * "idle" with a tick count stuck at zero.
     */
    it("accepts the dashboard's own fetch where the caller allows it", () => {
      withSecret(() => {
        const own = request({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" });
        expect(isAuthorised(own, { allowSameOrigin: true })).toBe(true);
        // Off by default, so reset and improve stay secret-only.
        expect(isAuthorised(own)).toBe(false);
      });
    });

    it("rejects a cross-site post even where same-origin is allowed", () => {
      withSecret(() => {
        for (const site of ["cross-site", "same-site", "none"]) {
          const req = request({ "sec-fetch-site": site, "sec-fetch-mode": "cors" });
          expect(isAuthorised(req, { allowSameOrigin: true })).toBe(false);
        }
      });
    });

    it("rejects a top-level navigation, which is a link or a crawler", () => {
      withSecret(() => {
        const nav = request({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" });
        expect(isAuthorised(nav, { allowSameOrigin: true })).toBe(false);
      });
    });

    it("rejects a request carrying no fetch metadata at all", () => {
      withSecret(() => {
        expect(isAuthorised(request(), { allowSameOrigin: true })).toBe(false);
      });
    });
  });
});
