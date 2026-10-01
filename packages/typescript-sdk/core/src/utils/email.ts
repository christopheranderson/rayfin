export const EMAIL_REGEX =
  // eslint-disable-next-line no-empty-character-class
  /^([-!#-'*+/\-0-9=?A-Z^-~]+(\.[-!#-'*+/\-0-9=?A-Z^-~]+)*|"([]!#-[^-~ \t]|(\\[\t -~]))+")@[0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?(\.[0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?)*(\.[0-9A-Za-z]{2,})$/;

export const isValidEmail = (email: string): boolean => {
  if (email === undefined || email === null || typeof email !== 'string') {
    throw new TypeError('Email must be a string');
  }
  return EMAIL_REGEX.test(email);
};
