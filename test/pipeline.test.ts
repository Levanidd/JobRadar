import { describe, expect, it } from "vitest"

import { companyKey, companiesRelated, dedupKey, locationKey, titleKey } from "../src/company-key"
import { parsePlaces, placesMatch } from "../src/places"
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

  it("keeps a speciality in parentheses and drops only a place", () => {
    expect(titleKey("Senior Product Manager (Payments)")).toBe("senior product manager payments")
    expect(titleKey("Senior Product Manager (ERP)")).toBe("senior product manager erp")
    expect(titleKey("(Senior) Product Manager")).toBe("senior product manager")
    expect(titleKey("Product Manager (maternity cover)")).toBe("product manager maternity cover")
    expect(titleKey("Product Manager (Berlin)")).toBe("product manager")
    expect(titleKey("Senior Product Manager (all genders)")).toBe("senior product manager")
  })
})

describe("places", () => {
  it("reads a city out of an office name and ignores a stub", () => {
    expect(locationKey("Berlin Tech")).toBe("berlin")
    expect(locationKey("Blacklane London")).toBe("london")
    expect(locationKey("Staffbase GmbH, Chemnitz")).toBe("chemnitz")
    expect(locationKey("Apaleo HQ")).toBe("")
    expect(locationKey("3 Locations")).toBe("")
    expect(locationKey("Berlin, Berlin, Germany; Berlin")).toBe("berlin+germany")
    expect(locationKey("Berlin, Germany; Berlin")).toBe("berlin+germany")
    expect(locationKey("Berlin, DEU")).toBe("berlin+germany")
    expect(locationKey("Berlin, BE, Germany")).toBe("berlin+germany")
    expect(locationKey("München, BY, Germany")).toBe("germany+munich")
    expect(locationKey("Berlin, Germany")).toBe(locationKey("Berlin, BE, Germany"))
  })

  it("matches on a shared city and refuses a remote country", () => {
    const berlin = parsePlaces("Berlin, Germany")
    const many = parsePlaces("Milan; Madrid; Berlin; Paris")
    const remote = parsePlaces("Remote (Germany)")
    const germany = parsePlaces("Germany")
    expect(placesMatch(many, parsePlaces("Berlin"))).toBe(true)
    expect(placesMatch(berlin, parsePlaces("London, UK"))).toBe(false)
    expect(placesMatch(germany, berlin)).toBe(true)
    expect(placesMatch(germany, many)).toBe(false)
    expect(placesMatch(parsePlaces("Germany"), parsePlaces("Deutschland"))).toBe(true)
    expect(placesMatch(parsePlaces("Germany"), parsePlaces("France"))).toBe(false)
    expect(placesMatch(remote, berlin)).toBe(false)
    expect(placesMatch(parsePlaces("EMEA"), berlin)).toBe(false)
    expect(placesMatch(parsePlaces(""), berlin)).toBe(false)
    expect(placesMatch(parsePlaces(""), parsePlaces("Remote"))).toBe(false)
    expect(placesMatch(parsePlaces("Remote"), parsePlaces("Remote"))).toBe(false)
    expect(placesMatch(parsePlaces(""), parsePlaces(""))).toBe(true)
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

  it("does not treat internal or international as an intern role", () => {
    const result = localScore({
      external_id: "1",
      title: "Staff Product Manager",
      company: "Databricks",
      location: "Berlin, Germany",
      description: "Work with internal teams on an international product.",
    })
    expect(result.score).toBeGreaterThan(0)
    expect(result.flags).not.toContain("not_senior")
  })
})
