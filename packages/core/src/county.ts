/**
 * County for planner grouping. postcodes.io gives `admin_county` only for two-tier areas; unitary,
 * metropolitan and London authorities have none, so they map here to their (ceremonial) county.
 * Anything not listed (Welsh / Scottish authorities, unitary counties such as Wiltshire or Cornwall)
 * keeps its authority name.
 */
const BY_AUTHORITY: Record<string, string[]> = {
  Bedfordshire: ['Bedford', 'Central Bedfordshire', 'Luton'],
  Berkshire: ['Bracknell Forest', 'Reading', 'Slough', 'West Berkshire', 'Windsor and Maidenhead', 'Wokingham'],
  Bristol: ['Bristol, City of'],
  Buckinghamshire: ['Milton Keynes'],
  Cambridgeshire: ['Peterborough'],
  Cheshire: ['Cheshire East', 'Cheshire West and Chester', 'Halton', 'Warrington'],
  Cornwall: ['Isles of Scilly'],
  Cumbria: ['Cumberland', 'Westmorland and Furness'],
  Derbyshire: ['Derby'],
  Devon: ['Plymouth', 'Torbay'],
  Dorset: ['Bournemouth, Christchurch and Poole'],
  Durham: ['County Durham', 'Darlington', 'Hartlepool', 'Stockton-on-Tees'],
  'East Riding of Yorkshire': ['Kingston upon Hull, City of'],
  'East Sussex': ['Brighton and Hove'],
  Essex: ['Southend-on-Sea', 'Thurrock'],
  Gloucestershire: ['South Gloucestershire'],
  'Greater London': [
    'Barking and Dagenham', 'Barnet', 'Bexley', 'Brent', 'Bromley', 'Camden', 'City of London', 'Croydon', 'Ealing',
    'Enfield', 'Greenwich', 'Hackney', 'Hammersmith and Fulham', 'Haringey', 'Harrow', 'Havering', 'Hillingdon',
    'Hounslow', 'Islington', 'Kensington and Chelsea', 'Kingston upon Thames', 'Lambeth', 'Lewisham', 'Merton',
    'Newham', 'Redbridge', 'Richmond upon Thames', 'Southwark', 'Sutton', 'Tower Hamlets', 'Waltham Forest',
    'Wandsworth', 'Westminster',
  ],
  'Greater Manchester': ['Bolton', 'Bury', 'Manchester', 'Oldham', 'Rochdale', 'Salford', 'Stockport', 'Tameside', 'Trafford', 'Wigan'],
  Hampshire: ['Portsmouth', 'Southampton'],
  Herefordshire: ['Herefordshire, County of'],
  Kent: ['Medway'],
  Lancashire: ['Blackburn with Darwen', 'Blackpool'],
  Leicestershire: ['Leicester'],
  Lincolnshire: ['North Lincolnshire', 'North East Lincolnshire'],
  Merseyside: ['Knowsley', 'Liverpool', 'St. Helens', 'Sefton', 'Wirral'],
  Northamptonshire: ['North Northamptonshire', 'West Northamptonshire'],
  'North Yorkshire': ['York', 'Middlesbrough', 'Redcar and Cleveland'],
  Nottinghamshire: ['Nottingham'],
  Shropshire: ['Telford and Wrekin'],
  Somerset: ['Bath and North East Somerset', 'North Somerset'],
  'South Yorkshire': ['Barnsley', 'Doncaster', 'Rotherham', 'Sheffield'],
  Staffordshire: ['Stoke-on-Trent'],
  'Tyne and Wear': ['Gateshead', 'Newcastle upon Tyne', 'North Tyneside', 'South Tyneside', 'Sunderland'],
  'West Midlands': ['Birmingham', 'Coventry', 'Dudley', 'Sandwell', 'Solihull', 'Walsall', 'Wolverhampton'],
  'West Yorkshire': ['Bradford', 'Calderdale', 'Kirklees', 'Leeds', 'Wakefield'],
  Wiltshire: ['Swindon'],
};

const COUNTY_OF = new Map<string, string>(Object.entries(BY_AUTHORITY).flatMap(([county, lads]) => lads.map((l) => [l, county] as const)));

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
};

/** The county to group under, from postcodes.io's `admin_county` and `admin_district` for one point. */
export function countyFor(adminCounty: string | null | undefined, adminDistrict: string | null | undefined): string | null {
  const county = clean(adminCounty);
  if (county) return county;
  const lad = clean(adminDistrict);
  return lad === null ? null : (COUNTY_OF.get(lad) ?? lad);
}
