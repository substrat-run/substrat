/**
 * A Swedish personal number (personnummer, or samordningsnummer), as BankID asserts it: twelve
 * digits, `YYYYMMDDNNNC`, where `C` is a Luhn check digit over the last ten.
 *
 * The number is a sensitive identifier, so nothing here ever puts it in a message: a refusal
 * says what is wrong with the shape, never what the value was.
 */

/** Luhn over a run of digits, the last of which is the check digit. */
function luhnHolds(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let v = Number(digits[i]) * (i % 2 === 0 ? 2 : 1);
    if (v > 9) v -= 9;
    sum += v;
  }
  return sum % 10 === 0;
}

/**
 * The number as BankID's completion data carries it — twelve digits, no separator — or a reason
 * it is not one. A hyphen between the date and the serial (`YYYYMMDD-NNNN`) is accepted and
 * dropped. The ten-digit form is refused: its century is a guess, and a wrong guess is another
 * person's number.
 */
export function normalizePersonalNumber(input: string): { value: string } | { refused: string } {
  const match = /^(\d{8})-?(\d{4})$/.exec(input.trim());
  if (!match) return { refused: 'personalNumber must be twelve digits, YYYYMMDDNNNN' };
  const value = `${match[1]}${match[2]}`;
  const month = Number(value.slice(4, 6));
  // A samordningsnummer adds 60 to the day.
  const rawDay = Number(value.slice(6, 8));
  const day = rawDay > 60 ? rawDay - 60 : rawDay;
  if (month < 1 || month > 12 || day < 1 || day > 31) return { refused: 'personalNumber does not hold a valid date' };
  if (!luhnHolds(value.slice(2))) return { refused: 'personalNumber has an invalid check digit' };
  return { value };
}

/**
 * Does this string look like a personal number in any common spelling (ten or twelve digits,
 * with or without a separator)? For refusing one where it must not be used as a name or a key.
 */
export function looksLikePersonalNumber(input: string): boolean {
  return /^(\d{2})?\d{6}[-+]?\d{4}$/.test(input.trim());
}
