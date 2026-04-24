INSERT INTO app_data (key, value)
VALUES ('users', '[{"id":"user-eran-001","username":"eran@ringoffireclothing.com","name":"Eran","password":"8d1a1a396572f13524f2d2483427d94848ba4311b007a30912bbe1885bda7a41","role":"admin","initials":"ER","color":"#CC2200"}]'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
