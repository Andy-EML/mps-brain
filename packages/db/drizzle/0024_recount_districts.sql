-- County was taken from the first admin_county postcodes.io listed for the outward code, which can be
-- a minority neighbour (RG20 -> Hampshire) and is empty for unitary / metropolitan / London areas.
-- postcode-lookup now asks for the authority at the district centre; drop the cache so it refills.
DELETE FROM "postcode_districts";
