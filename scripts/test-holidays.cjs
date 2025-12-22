/**
 * Test the dynamic Philippines holiday detection
 */
const Holidays = require('date-holidays');

// Initialize Philippines holidays
const phHolidays = new Holidays('PH');

console.log('=====================================================');
console.log('       Philippines Holiday Detection Test');
console.log('       Using date-holidays npm package');
console.log('=====================================================\n');

// Test specific dates
const testDates = [
  '2025-12-08', // Feast of Immaculate Conception
  '2025-12-09', // Should NOT be a holiday (user's concern)
  '2025-12-24', // Christmas Eve
  '2025-12-25', // Christmas Day
  '2025-01-01', // New Year's Day
  '2025-04-17', // Maundy Thursday
  '2025-04-18', // Good Friday
  '2025-05-01', // Labor Day
  '2025-06-12', // Independence Day
  '2025-08-21', // Ninoy Aquino Day
  '2025-11-01', // All Saints' Day
];

console.log('Testing specific dates:');
console.log('-'.repeat(60));

for (const dateStr of testDates) {
  const date = new Date(dateStr);
  const result = phHolidays.isHoliday(date);

  if (result && result.length > 0) {
    console.log(`${dateStr}: HOLIDAY - ${result[0].name} (${result[0].type})`);
  } else {
    console.log(`${dateStr}: Not a holiday`);
  }
}

console.log('\n' + '='.repeat(60));
console.log('All 2025 Philippines Holidays:');
console.log('='.repeat(60) + '\n');

// Get all 2025 holidays
const holidays2025 = phHolidays.getHolidays(2025);

// Sort by date
holidays2025.sort((a, b) => new Date(a.date) - new Date(b.date));

// Display all holidays
for (const h of holidays2025) {
  const dateStr = h.date.toISOString().split('T')[0];
  console.log(`${dateStr}: ${h.name} (${h.type})`);
}

console.log('\n' + '='.repeat(60));
console.log('Summary:');
console.log('='.repeat(60));

const publicHolidays = holidays2025.filter(h => h.type === 'public');
const bankHolidays = holidays2025.filter(h => h.type === 'bank');
const optionalHolidays = holidays2025.filter(h => h.type === 'optional');
const observanceHolidays = holidays2025.filter(h => h.type === 'observance');

console.log(`Total holidays in 2025: ${holidays2025.length}`);
console.log(`  - Public holidays: ${publicHolidays.length}`);
console.log(`  - Bank holidays: ${bankHolidays.length}`);
console.log(`  - Optional holidays: ${optionalHolidays.length}`);
console.log(`  - Observances: ${observanceHolidays.length}`);

// Verify December 8 and 9
console.log('\n' + '='.repeat(60));
console.log('December 8 vs December 9 (User concern):');
console.log('='.repeat(60));

const dec8 = phHolidays.isHoliday(new Date('2025-12-08'));
const dec9 = phHolidays.isHoliday(new Date('2025-12-09'));

console.log(`Dec 8, 2025: ${dec8 ? 'HOLIDAY - ' + dec8[0].name : 'Not a holiday'}`);
console.log(`Dec 9, 2025: ${dec9 ? 'HOLIDAY - ' + dec9[0].name : 'Not a holiday'}`);

// Test our internal getHolidaysForYear function
console.log('\n' + '='.repeat(60));
console.log('Testing iLoad Internal Holiday Detection:');
console.log('='.repeat(60));
console.log('\nTo verify Dec 9 is detected by our merged system:');
console.log('Run: node -e "import(\'./dist/constants/index.js\').then(m => console.log(\'Dec 9 is holiday:\', m.isPhilippineHoliday(\'2025-12-09\')))"');
