import { describe, expect, it } from "vitest";
import { cronMatches, hasMissedRun, lastDueBefore, parseCron } from "./index";

const BERLIN = "Europe/Berlin";
const UTC = "UTC";

describe("parseCron", () => {
  it("liest die fünf Standardfelder", () => {
    const c = parseCron("30 7 * * 1-5");
    expect(c).not.toBeNull();
    expect([...c!.minute]).toEqual([30]);
    expect([...c!.hour]).toEqual([7]);
    expect([...c!.dayOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(c!.dayOfMonthRestricted).toBe(false);
    expect(c!.dayOfWeekRestricted).toBe(true);
  });

  it("verwirft das führende Sekundenfeld der sechsstelligen Form", () => {
    const fuenf = parseCron("0 15 * * *");
    const sechs = parseCron("0 0 15 * * *");
    expect([...sechs!.hour]).toEqual([...fuenf!.hour]);
    expect([...sechs!.minute]).toEqual([...fuenf!.minute]);
  });

  it("behandelt 7 als Sonntag", () => {
    expect([...parseCron("0 0 * * 7")!.dayOfWeek]).toEqual([0]);
  });

  it("löst Schrittwerte auf", () => {
    expect([...parseCron("*/15 * * * *")!.minute]).toEqual([0, 15, 30, 45]);
    // "5/10" heißt: ab 5, dann alle 10.
    expect([...parseCron("5/10 * * * *")!.minute]).toEqual([5, 15, 25, 35, 45, 55]);
  });

  it("gibt null zurück statt still nichts zu treffen", () => {
    expect(parseCron("")).toBeNull();
    expect(parseCron("* * *")).toBeNull();
    expect(parseCron("60 * * * *")).toBeNull(); // Minute 60 gibt es nicht
    expect(parseCron("* 24 * * *")).toBeNull();
    expect(parseCron("abc * * * *")).toBeNull();
    expect(parseCron("*/0 * * * *")).toBeNull();
    expect(parseCron("10-5 * * * *")).toBeNull();
  });
});

describe("cronMatches", () => {
  it("wertet den Ausdruck in der angegebenen Zone aus", () => {
    const c = parseCron("0 7 * * *")!;
    // 05:00 UTC ist im Sommer 07:00 in Berlin.
    const sommer = new Date("2026-07-01T05:00:00Z");
    expect(cronMatches(c, sommer, BERLIN)).toBe(true);
    expect(cronMatches(c, sommer, UTC)).toBe(false);
  });

  it("folgt der Zeitumstellung", () => {
    const c = parseCron("0 7 * * *")!;
    // Im Winter ist 07:00 Berlin gleich 06:00 UTC.
    const winter = new Date("2026-01-15T06:00:00Z");
    expect(cronMatches(c, winter, BERLIN)).toBe(true);
    expect(cronMatches(c, new Date("2026-01-15T05:00:00Z"), BERLIN)).toBe(false);
  });

  it("verknüpft Monatstag und Wochentag mit ODER, wenn beide gesetzt sind", () => {
    // Der 1. jedes Monats UND jeder Montag, nicht deren Schnittmenge.
    const c = parseCron("0 0 1 * 1")!;
    const ersterMittwoch = new Date("2026-07-01T00:00:00Z"); // 1. Juli 2026, Mittwoch
    const einMontag = new Date("2026-07-06T00:00:00Z");
    expect(cronMatches(c, ersterMittwoch, UTC)).toBe(true);
    expect(cronMatches(c, einMontag, UTC)).toBe(true);
    expect(cronMatches(c, new Date("2026-07-07T00:00:00Z"), UTC)).toBe(false);
  });

  it("verknüpft mit UND, wenn nur eines der beiden Felder gesetzt ist", () => {
    const nurTag = parseCron("0 0 15 * *")!;
    expect(cronMatches(nurTag, new Date("2026-07-15T00:00:00Z"), UTC)).toBe(true);
    expect(cronMatches(nurTag, new Date("2026-07-16T00:00:00Z"), UTC)).toBe(false);
  });
});

describe("lastDueBefore", () => {
  it("findet den letzten fälligen Zeitpunkt", () => {
    const jetzt = new Date("2026-07-15T10:17:00Z"); // Mittwoch
    const due = lastDueBefore("0 * * * *", jetzt, UTC);
    expect(due?.toISOString()).toBe("2026-07-15T10:00:00.000Z");
  });

  it("liegt echt vor dem Bezugszeitpunkt", () => {
    // Genau zur vollen Stunde darf nicht die laufende Ausführung gemeldet
    // werden, sonst sieht ein gerade startender Lauf überfällig aus.
    const jetzt = new Date("2026-07-15T10:00:00Z");
    expect(lastDueBefore("0 * * * *", jetzt, UTC)?.toISOString()).toBe(
      "2026-07-15T09:00:00.000Z",
    );
  });

  it("überspringt das Wochenende bei einem Mo-Fr-Ausdruck", () => {
    // Sonntag, 12. Juli 2026, 09:00 UTC. Letzte Fälligkeit: Freitag 07:00
    // Berlin, das sind 05:00 UTC im Sommer.
    const sonntag = new Date("2026-07-12T09:00:00Z");
    const due = lastDueBefore("0 7 * * 1-5", sonntag, BERLIN);
    expect(due?.toISOString()).toBe("2026-07-10T05:00:00.000Z");
  });

  it("gibt null zurück, wenn im Fenster nichts fällig war", () => {
    // Jährlich am 1. Januar, Fenster nur sieben Tage.
    expect(lastDueBefore("0 0 1 1 *", new Date("2026-07-15T00:00:00Z"), UTC)).toBeNull();
  });

  it("findet dieselbe Fälligkeit mit größerem Fenster", () => {
    const due = lastDueBefore("0 0 1 1 *", new Date("2026-07-15T00:00:00Z"), UTC, {
      lookbackMs: 400 * 24 * 3600_000,
    });
    expect(due?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("gibt null zurück bei ungültigem Ausdruck", () => {
    expect(lastDueBefore("kaputt", new Date(), UTC)).toBeNull();
  });
});

describe("hasMissedRun", () => {
  const jetzt = new Date("2026-07-15T10:30:00Z"); // Mittwoch

  it("meldet einen verpassten Lauf", () => {
    const letzter = new Date("2026-07-15T08:00:00Z");
    expect(hasMissedRun("0 * * * *", letzter, jetzt, UTC)).toBe(true);
  });

  it("meldet nichts, solange der Lauf innerhalb der Toleranz liegt", () => {
    // Fällig war 10:00, gelaufen 09:58. Zwei Minuten früh liegt im Rahmen.
    const letzter = new Date("2026-07-15T09:58:00Z");
    expect(hasMissedRun("0 * * * *", letzter, jetzt, UTC)).toBe(false);
  });

  it("meldet am Wochenende nichts für einen Mo-Fr-Ausdruck", () => {
    // Das ist der Fehlalarm, für den diese Bibliothek existiert: Sonntag,
    // letzter Lauf am Freitag, und eine pauschale 36-Stunden-Regel hätte hier
    // Alarm geschlagen.
    const sonntag = new Date("2026-07-12T09:00:00Z");
    const freitag = new Date("2026-07-10T05:00:00Z");
    expect(hasMissedRun("0 7 * * 1-5", freitag, sonntag, BERLIN)).toBe(false);
    expect(sonntag.getTime() - freitag.getTime()).toBeGreaterThan(36 * 3600_000);
  });

  it("wertet einen fehlenden Lauf als verpasst, sobald etwas fällig war", () => {
    expect(hasMissedRun("0 * * * *", null, jetzt, UTC)).toBe(true);
  });

  it("meldet nichts, wenn im Fenster nichts fällig war", () => {
    expect(hasMissedRun("0 0 1 1 *", null, jetzt, UTC)).toBe(false);
  });

  it("nimmt eine eigene Toleranz an", () => {
    const letzter = new Date("2026-07-15T09:50:00Z");
    expect(hasMissedRun("0 * * * *", letzter, jetzt, UTC, { toleranceMs: 60_000 })).toBe(true);
    expect(hasMissedRun("0 * * * *", letzter, jetzt, UTC, { toleranceMs: 20 * 60_000 })).toBe(false);
  });
});
