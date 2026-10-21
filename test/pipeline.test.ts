import { describe, expect, it } from "vitest"

import { companyKey, companiesRelated, titleKey } from "../src/company-key"
import { isSuspicious } from "../src/ingest"
import { passesPrefilter, sanitizeTags } from "../src/prefilter"
import { sanitizeCompanyBlacklist } from "../src/settings"
import { formatSalary, toSalary } from "../src/salary"
import { localScore } from "../src/scoring"

describe("companyKey", () => {
  it("collapses legal suffixes and punctuation", () => {
    expect(companyKey("Acme GmbH")).toBe("acme")
    expect(companyKey("Beispiel Bank AG")).toBe("beispiel bank")
    expect(companyKey("Foo, Inc.")).toBe("foo")
  })

  it("treats a legal name as the same employer as its short slug", () => {
    expect(companiesRelated("acme", "acme digital")).toBe(true)
    expect(companiesRelated("pammys dieseo", "pammys")).toBe(true)
    expect(companiesRelated("acme digital", "acme labs")).toBe(false)
  })

  it("drops city and gender tags from a role name", () => {
    expect(titleKey("Senior Product Manager (m/w/d) – Berlin")).toBe("senior product manager")
    expect(titleKey("Sr. Product Manager")).toBe("senior product manager")
    expect(titleKey("Product Manager - Growth")).toBe("product manager growth")
  })
})

describe("prefilter", () => {
  it("keeps product roles and drops students", () => {
    expect(passesPrefilter("Senior Product Manager")).toBe(true)
    expect(passesPrefilter("Werkstudent Produktmanagement")).toBe(false)
    expect(passesPrefilter("Backend Engineer")).toBe(false)
  })

  it("ignores case and extra whitespace", () => {
    expect(passesPrefilter("  SENIOR   PRODUCT   MANAGER  ")).toBe(true)
    expect(passesPrefilter("Ai  Product Lead", { keep: ["ai product"], drop: [] })).toBe(true)
  })

  it("uses the supplied keep and drop tags", () => {
    const rules = { keep: ["Produktmanager"], drop: ["Werkstudent"] }
    expect(passesPrefilter("Senior Produktmanager", rules)).toBe(true)
    expect(passesPrefilter("Werkstudent Produktmanager", rules)).toBe(false)
    expect(passesPrefilter("Backend Engineer", rules)).toBe(false)
  })

  it("rejects everything when keep is empty", () => {
    expect(passesPrefilter("Senior Product Manager", { keep: [], drop: [] })).toBe(false)
  })

  it("collapses duplicates and extra spaces in tags", () => {
    expect(sanitizeTags(["  Product   Manager  ", "product manager", "", 12])).toEqual(["Product Manager"])
  })
})

describe("company blacklist", () => {
  it("keeps display names and unique keys", () => {
    expect(
      sanitizeCompanyBlacklist([
        { company_key: "Acme", company: "  Acme GmbH  " },
        { company_key: "acme", company: "Acme" },
        { company_key: "", company: "Nope" },
        { company: "Missing key" },
      ]),
    ).toEqual([{ company_key: "acme", company: "Acme GmbH" }])
  })
})

describe("ingest guard", () => {
  it("flags a truncated fetch", () => {
    expect(isSuspicious(100, 40)).toBe(true)
    expect(isSuspicious(100, 80)).toBe(false)
    expect(isSuspicious(null, 0)).toBe(false)
  })
})

describe("salary", () => {
  it("normalises yearly ranges and greenhouse cents", () => {
    expect(toSalary({ min: 80_000, max: 110_000, currency: "eur" })).toEqual({
      min: 80_000,
      max: 110_000,
      currency: "EUR",
    })
    expect(toSalary({ min: 8_000_000, max: 11_000_000, currency: "EUR", cents: true })).toEqual({
      min: 80_000,
      max: 110_000,
      currency: "EUR",
    })
    expect(toSalary({ min: 40, period: "hour", currency: "EUR" })?.min).toBe(83_200)
    expect(formatSalary(80_000, 110_000, "EUR")).toBe("€80k–110k")
    expect(formatSalary(150_000, null, "USD")).toBe("from $150k")
  })
})

describe("local scoring", () => {
  it("zeros junior roles", () => {
    const result = localScore({
      external_id: "1",
      title: "Jr. Product Manager",
      company: "X",
      location: "Köln",
      description: "Junior role",
    })
    expect(result.score).toBe(0)
    expect(result.flags).toContain("not_senior")
  })
})
