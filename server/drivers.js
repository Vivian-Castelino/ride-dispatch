// Hardcoded fake drivers, as the task allows.
const NAMES = [
  'Aarav', 'Vihaan', 'Diya', 'Ishaan', 'Meera',
  'Kabir', 'Anaya', 'Rohan', 'Saanvi', 'Arjun',
];

export const DRIVERS = NAMES.map((name, i) => ({
  id: `D${String(i + 1).padStart(2, '0')}`,
  name,
}));
