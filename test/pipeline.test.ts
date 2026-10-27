import { describe, expect, it } from "vitest"

import { companyKey, companiesRelated, dedupKey, locationKey, titleKey } from "../src/company-key"
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

describe("locationKey", () => {
  it("treats the same city spelled with a country code as one place", () => {
    const berlin = "berlin+germany"
    expect(locationKey("Berlin, Germany; Berlin")).toBe(berlin)
    expect(locationKey("Berlin, Germany")).toBe(berlin)
    expect(locationKey("Berlin, DEU")).toBe(berlin)
  })

  it("keeps different cities apart, including a remote country", () => {
    expect(locationKey("London, UK")).toBe("london+uk")
    expect(locationKey("London, United Kingdom")).toBe("london+uk")
    expect(locationKey("New York, NY")).toBe("new york")
    expect(locationKey("NYC")).toBe("new york")
    expect(locationKey("Remote (Germany)")).toBe("germany")
    expect(locationKey("Berlin, Germany")).not.toBe(locationKey("London, UK"))
    expect(locationKey("Berlin, Germany")).not.toBe(locationKey("New York, NY"))
    expect(locationKey("Remote (Germany)")).not.toBe(locationKey("Berlin, Germany"))
    expect(locationKey("Palo Alto")).toBe("palo alto")
    expect(locationKey("San Francisco, CA")).toBe("san francisco")
    expect(locationKey("München")).toBe("munich")
    expect(locationKey("Remote")).toBe("")
    expect(locationKey("")).toBe("")
  })
})

describe("dedupKey", () => {
  it("includes the place, and omits it only when the place is unknown", () => {
    const role = "Senior Product Manager, Payments"
    expect(dedupKey("Navan", role, "Berlin, Germany")).toBe("navan|senior product manager payments|berlin+germany")
    expect(dedupKey("Navan", role, "London, UK; London")).toBe("navan|senior product manager payments|london+uk")
    expect(dedupKey("Navan", role, "London, United Kingdom")).toBe("navan|senior product manager payments|london+uk")
    expect(dedupKey("Navan", role, "New York, NY")).toBe("navan|senior product manager payments|new york")
    expect(dedupKey("Navan", role)).toBe("navan|senior product manager payments")
    expect(dedupKey("Navan", role, "Berlin, Germany")).not.toBe(dedupKey("Navan", role, "London, UK"))
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
