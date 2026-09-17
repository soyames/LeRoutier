-- Canonical Benin geography, independent of transport routes: 12 departments
-- and their 77 communes, with coordinates and common spelling aliases. One
-- shared reference for passenger search, parcels, route/stop creation,
-- operator setup and first/last mile. Idempotent: stable ids, no duplicate
-- places, existing route-linked places untouched.

ALTER TABLE places ADD COLUMN normalized_name text;
ALTER TABLE places ADD COLUMN aliases jsonb NOT NULL DEFAULT '[]';
ALTER TABLE places ADD COLUMN source text;
ALTER TABLE places ADD COLUMN source_id text;
ALTER TABLE places ADD COLUMN latitude double precision CHECK(latitude BETWEEN -90 AND 90);
ALTER TABLE places ADD COLUMN longitude double precision CHECK(longitude BETWEEN -180 AND 180);
CREATE INDEX places_normalized ON places(normalized_name);
CREATE UNIQUE INDEX places_source_once ON places(source,source_id) WHERE source IS NOT NULL;

-- Department and commune rows. kind follows the existing vocabulary
-- ('department','city') and the hierarchy is country -> department -> commune.
INSERT INTO places(id,parent_id,name,normalized_name,kind,country_code,latitude,longitude,aliases,source,source_id) VALUES
-- Alibori
('00000000-0000-4000-b000-000000000101',NULL,'Alibori','alibori','department','BJ',11.13,2.94,'[]','benin-geography','dep:alibori'),
('00000000-0000-4000-b000-000000000111','00000000-0000-4000-b000-000000000101','Banikoara','banikoara','city','BJ',11.30,2.44,'[]','benin-geography','com:banikoara'),
('00000000-0000-4000-b000-000000000112','00000000-0000-4000-b000-000000000101','Gogounou','gogounou','city','BJ',10.84,2.82,'[]','benin-geography','com:gogounou'),
('00000000-0000-4000-b000-000000000113','00000000-0000-4000-b000-000000000101','Kandi','kandi','city','BJ',11.13,2.94,'[]','benin-geography','com:kandi'),
('00000000-0000-4000-b000-000000000114','00000000-0000-4000-b000-000000000101','Karimama','karimama','city','BJ',12.07,3.18,'[]','benin-geography','com:karimama'),
('00000000-0000-4000-b000-000000000115','00000000-0000-4000-b000-000000000101','Malanville','malanville','city','BJ',11.87,3.39,'[]','benin-geography','com:malanville'),
('00000000-0000-4000-b000-000000000116','00000000-0000-4000-b000-000000000101','Segbana','segbana','city','BJ',10.93,3.69,'[]','benin-geography','com:segbana'),
-- Atacora
('00000000-0000-4000-b000-000000000102',NULL,'Atacora','atacora','department','BJ',10.33,1.35,'[]','benin-geography','dep:atacora'),
('00000000-0000-4000-b000-000000000121','00000000-0000-4000-b000-000000000102','Boukoumbé','boukoumbe','city','BJ',10.18,1.10,'["Boukombe"]','benin-geography','com:boukoumbe'),
('00000000-0000-4000-b000-000000000122','00000000-0000-4000-b000-000000000102','Cobly','cobly','city','BJ',10.49,0.99,'[]','benin-geography','com:cobly'),
('00000000-0000-4000-b000-000000000123','00000000-0000-4000-b000-000000000102','Kérou','kerou','city','BJ',10.83,2.10,'["Kerou"]','benin-geography','com:kerou'),
('00000000-0000-4000-b000-000000000124','00000000-0000-4000-b000-000000000102','Kouandé','kouande','city','BJ',10.33,1.69,'["Kouande"]','benin-geography','com:kouande'),
('00000000-0000-4000-b000-000000000125','00000000-0000-4000-b000-000000000102','Matéri','materi','city','BJ',10.70,1.06,'["Materi"]','benin-geography','com:materi'),
('00000000-0000-4000-b000-000000000126','00000000-0000-4000-b000-000000000102','Natitingou','natitingou','city','BJ',10.30,1.38,'[]','benin-geography','com:natitingou'),
('00000000-0000-4000-b000-000000000127','00000000-0000-4000-b000-000000000102','Pehunco','pehunco','city','BJ',10.23,2.00,'[]','benin-geography','com:pehunco'),
('00000000-0000-4000-b000-000000000128','00000000-0000-4000-b000-000000000102','Tanguiéta','tanguieta','city','BJ',10.62,1.26,'["Tanguieta"]','benin-geography','com:tanguieta'),
('00000000-0000-4000-b000-000000000129','00000000-0000-4000-b000-000000000102','Toucountouna','toucountouna','city','BJ',10.49,1.37,'[]','benin-geography','com:toucountouna'),
-- Atlantique
('00000000-0000-4000-b000-000000000103',NULL,'Atlantique','atlantique','department','BJ',6.64,2.22,'[]','benin-geography','dep:atlantique'),
('00000000-0000-4000-b000-000000000131','00000000-0000-4000-b000-000000000103','Abomey-Calavi','abomey-calavi','city','BJ',6.45,2.36,'["Abomey Calavi","Calavi"]','benin-geography','com:abomey-calavi'),
('00000000-0000-4000-b000-000000000132','00000000-0000-4000-b000-000000000103','Allada','allada','city','BJ',6.67,2.15,'[]','benin-geography','com:allada'),
('00000000-0000-4000-b000-000000000133','00000000-0000-4000-b000-000000000103','Kpomassè','kpomasse','city','BJ',6.45,2.00,'["Kpomasse"]','benin-geography','com:kpomasse'),
('00000000-0000-4000-b000-000000000134','00000000-0000-4000-b000-000000000103','Ouidah','ouidah','city','BJ',6.36,2.08,'["Whydah"]','benin-geography','com:ouidah'),
('00000000-0000-4000-b000-000000000135','00000000-0000-4000-b000-000000000103','Sô-Ava','so-ava','city','BJ',6.47,2.41,'["So-Ava","So Ava"]','benin-geography','com:so-ava'),
('00000000-0000-4000-b000-000000000136','00000000-0000-4000-b000-000000000103','Toffo','toffo','city','BJ',6.86,2.08,'[]','benin-geography','com:toffo'),
('00000000-0000-4000-b000-000000000137','00000000-0000-4000-b000-000000000103','Tori-Bossito','tori-bossito','city','BJ',6.50,2.15,'["Tori Bossito"]','benin-geography','com:tori-bossito'),
('00000000-0000-4000-b000-000000000138','00000000-0000-4000-b000-000000000103','Zè','ze','city','BJ',6.76,2.30,'["Ze"]','benin-geography','com:ze'),
-- Borgou
('00000000-0000-4000-b000-000000000104',NULL,'Borgou','borgou','department','BJ',9.34,2.62,'[]','benin-geography','dep:borgou'),
('00000000-0000-4000-b000-000000000141','00000000-0000-4000-b000-000000000104','Bembèrèkè','bembereke','city','BJ',10.23,2.66,'["Bembereke"]','benin-geography','com:bembereke'),
('00000000-0000-4000-b000-000000000142','00000000-0000-4000-b000-000000000104','Kalalé','kalale','city','BJ',10.29,3.38,'["Kalale"]','benin-geography','com:kalale'),
('00000000-0000-4000-b000-000000000143','00000000-0000-4000-b000-000000000104','N''Dali','ndali','city','BJ',9.86,2.72,'["N Dali","Ndali"]','benin-geography','com:ndali'),
('00000000-0000-4000-b000-000000000144','00000000-0000-4000-b000-000000000104','Nikki','nikki','city','BJ',9.94,3.21,'["Niki"]','benin-geography','com:nikki'),
('00000000-0000-4000-b000-000000000145','00000000-0000-4000-b000-000000000104','Parakou','parakou','city','BJ',9.34,2.62,'[]','benin-geography','com:parakou'),
('00000000-0000-4000-b000-000000000146','00000000-0000-4000-b000-000000000104','Pèrèrè','perere','city','BJ',9.79,2.99,'["Perere"]','benin-geography','com:perere'),
('00000000-0000-4000-b000-000000000147','00000000-0000-4000-b000-000000000104','Sinendé','sinende','city','BJ',10.34,2.38,'["Sinende"]','benin-geography','com:sinende'),
('00000000-0000-4000-b000-000000000148','00000000-0000-4000-b000-000000000104','Tchaourou','tchaourou','city','BJ',8.89,2.60,'["Chaourou"]','benin-geography','com:tchaourou'),
-- Collines
('00000000-0000-4000-b000-000000000105',NULL,'Collines','collines','department','BJ',8.01,2.31,'[]','benin-geography','dep:collines'),
('00000000-0000-4000-b000-000000000151','00000000-0000-4000-b000-000000000105','Bantè','bante','city','BJ',8.42,1.88,'["Bante"]','benin-geography','com:bante'),
('00000000-0000-4000-b000-000000000152','00000000-0000-4000-b000-000000000105','Dassa-Zoumè','dassa-zoume','city','BJ',7.75,2.18,'["Dassa-Zoume","Dassa","Dassa Zoumè"]','benin-geography','com:dassa-zoume'),
('00000000-0000-4000-b000-000000000153','00000000-0000-4000-b000-000000000105','Glazoué','glazoue','city','BJ',7.97,2.24,'["Glazoue"]','benin-geography','com:glazoue'),
('00000000-0000-4000-b000-000000000154','00000000-0000-4000-b000-000000000105','Ouèssè','ouesse','city','BJ',8.49,2.43,'["Ouesse"]','benin-geography','com:ouesse'),
('00000000-0000-4000-b000-000000000155','00000000-0000-4000-b000-000000000105','Savalou','savalou','city','BJ',7.93,1.97,'[]','benin-geography','com:savalou'),
('00000000-0000-4000-b000-000000000156','00000000-0000-4000-b000-000000000105','Savè','save','city','BJ',8.03,2.49,'["Save"]','benin-geography','com:save'),
-- Couffo
('00000000-0000-4000-b000-000000000106',NULL,'Couffo','couffo','department','BJ',6.99,1.82,'[]','benin-geography','dep:couffo'),
('00000000-0000-4000-b000-000000000161','00000000-0000-4000-b000-000000000106','Aplahoué','aplahoue','city','BJ',6.93,1.69,'["Aplahoue"]','benin-geography','com:aplahoue'),
('00000000-0000-4000-b000-000000000162','00000000-0000-4000-b000-000000000106','Djakotomey','djakotomey','city','BJ',6.90,1.71,'[]','benin-geography','com:djakotomey'),
('00000000-0000-4000-b000-000000000163','00000000-0000-4000-b000-000000000106','Dogbo-Tota','dogbo-tota','city','BJ',6.80,1.78,'["Dogbo Tota","Dogbo"]','benin-geography','com:dogbo-tota'),
('00000000-0000-4000-b000-000000000164','00000000-0000-4000-b000-000000000106','Klouékanmè','klouekanme','city','BJ',7.04,1.85,'["Klouekanme"]','benin-geography','com:klouekanme'),
('00000000-0000-4000-b000-000000000165','00000000-0000-4000-b000-000000000106','Lalo','lalo','city','BJ',6.92,1.92,'[]','benin-geography','com:lalo'),
('00000000-0000-4000-b000-000000000166','00000000-0000-4000-b000-000000000106','Toviklin','toviklin','city','BJ',6.88,1.78,'[]','benin-geography','com:toviklin'),
-- Donga
('00000000-0000-4000-b000-000000000107',NULL,'Donga','donga','department','BJ',9.70,1.67,'[]','benin-geography','dep:donga'),
('00000000-0000-4000-b000-000000000171','00000000-0000-4000-b000-000000000107','Bassila','bassila','city','BJ',9.01,1.67,'[]','benin-geography','com:bassila'),
('00000000-0000-4000-b000-000000000172','00000000-0000-4000-b000-000000000107','Copargo','copargo','city','BJ',9.84,1.55,'[]','benin-geography','com:copargo'),
('00000000-0000-4000-b000-000000000173','00000000-0000-4000-b000-000000000107','Djougou','djougou','city','BJ',9.71,1.67,'[]','benin-geography','com:djougou'),
('00000000-0000-4000-b000-000000000174','00000000-0000-4000-b000-000000000107','Ouaké','ouake','city','BJ',9.66,1.38,'["Ouake"]','benin-geography','com:ouake'),
-- Littoral
('00000000-0000-4000-b000-000000000108',NULL,'Littoral','littoral','department','BJ',6.37,2.43,'[]','benin-geography','dep:littoral'),
('00000000-0000-4000-b000-000000000181','00000000-0000-4000-b000-000000000108','Cotonou','cotonou','city','BJ',6.36,2.43,'["Coutonou"]','benin-geography','com:cotonou'),
-- Mono
('00000000-0000-4000-b000-000000000109',NULL,'Mono','mono','department','BJ',6.64,1.75,'[]','benin-geography','dep:mono'),
('00000000-0000-4000-b000-000000000191','00000000-0000-4000-b000-000000000109','Athiémé','athieme','city','BJ',6.58,1.66,'["Athieme"]','benin-geography','com:athieme'),
('00000000-0000-4000-b000-000000000192','00000000-0000-4000-b000-000000000109','Bopa','bopa','city','BJ',6.59,1.98,'[]','benin-geography','com:bopa'),
('00000000-0000-4000-b000-000000000193','00000000-0000-4000-b000-000000000109','Comè','come','city','BJ',6.41,1.88,'["Come"]','benin-geography','com:come'),
('00000000-0000-4000-b000-000000000194','00000000-0000-4000-b000-000000000109','Grand-Popo','grand-popo','city','BJ',6.28,1.82,'["Grand Popo"]','benin-geography','com:grand-popo'),
('00000000-0000-4000-b000-000000000195','00000000-0000-4000-b000-000000000109','Houéyogbé','houeyogbe','city','BJ',6.51,1.83,'["Houeyogbe"]','benin-geography','com:houeyogbe'),
('00000000-0000-4000-b000-000000000196','00000000-0000-4000-b000-000000000109','Lokossa','lokossa','city','BJ',6.64,1.72,'[]','benin-geography','com:lokossa'),
-- Ouémé
('00000000-0000-4000-b000-00000000010a',NULL,'Ouémé','oueme','department','BJ',6.55,2.55,'["Oueme"]','benin-geography','dep:oueme'),
('00000000-0000-4000-b000-0000000001a1','00000000-0000-4000-b000-00000000010a','Adjarra','adjarra','city','BJ',6.53,2.63,'[]','benin-geography','com:adjarra'),
('00000000-0000-4000-b000-0000000001a2','00000000-0000-4000-b000-00000000010a','Adjohoun','adjohoun','city','BJ',6.72,2.47,'[]','benin-geography','com:adjohoun'),
('00000000-0000-4000-b000-0000000001a3','00000000-0000-4000-b000-00000000010a','Aguégués','aguegues','city','BJ',6.50,2.49,'["Aguegues"]','benin-geography','com:aguegues'),
('00000000-0000-4000-b000-0000000001a4','00000000-0000-4000-b000-00000000010a','Akpro-Missérété','akpro-misserete','city','BJ',6.56,2.59,'["Akpro-Misserete"]','benin-geography','com:akpro-misserete'),
('00000000-0000-4000-b000-0000000001a5','00000000-0000-4000-b000-00000000010a','Avrankou','avrankou','city','BJ',6.55,2.66,'[]','benin-geography','com:avrankou'),
('00000000-0000-4000-b000-0000000001a6','00000000-0000-4000-b000-00000000010a','Bonou','bonou','city','BJ',6.90,2.45,'[]','benin-geography','com:bonou'),
('00000000-0000-4000-b000-0000000001a7','00000000-0000-4000-b000-00000000010a','Dangbo','dangbo','city','BJ',6.58,2.55,'[]','benin-geography','com:dangbo'),
('00000000-0000-4000-b000-0000000001a8','00000000-0000-4000-b000-00000000010a','Porto-Novo','porto-novo','city','BJ',6.50,2.60,'["Porto Novo"]','benin-geography','com:porto-novo'),
('00000000-0000-4000-b000-0000000001a9','00000000-0000-4000-b000-00000000010a','Sèmè-Kpodji','seme-kpodji','city','BJ',6.38,2.62,'["Seme-Kpodji","Sèmè"]','benin-geography','com:seme-kpodji'),
-- Plateau
('00000000-0000-4000-b000-00000000010b',NULL,'Plateau','plateau','department','BJ',7.20,2.62,'[]','benin-geography','dep:plateau'),
('00000000-0000-4000-b000-0000000001b1','00000000-0000-4000-b000-00000000010b','Adja-Ouèrè','adja-ouere','city','BJ',7.00,2.62,'["Adja-Ouere"]','benin-geography','com:adja-ouere'),
('00000000-0000-4000-b000-0000000001b2','00000000-0000-4000-b000-00000000010b','Ifangni','ifangni','city','BJ',6.68,2.72,'[]','benin-geography','com:ifangni'),
('00000000-0000-4000-b000-0000000001b3','00000000-0000-4000-b000-00000000010b','Kétou','ketou','city','BJ',7.36,2.62,'["Ketou"]','benin-geography','com:ketou'),
('00000000-0000-4000-b000-0000000001b4','00000000-0000-4000-b000-00000000010b','Pobè','pobe','city','BJ',6.98,2.66,'["Pobe"]','benin-geography','com:pobe'),
('00000000-0000-4000-b000-0000000001b5','00000000-0000-4000-b000-00000000010b','Sakété','sakete','city','BJ',6.74,2.66,'["Sakete"]','benin-geography','com:sakete'),
-- Zou
('00000000-0000-4000-b000-00000000010c',NULL,'Zou','zou','department','BJ',7.24,2.10,'[]','benin-geography','dep:zou'),
('00000000-0000-4000-b000-0000000001c1','00000000-0000-4000-b000-00000000010c','Abomey','abomey','city','BJ',7.18,1.99,'[]','benin-geography','com:abomey'),
('00000000-0000-4000-b000-0000000001c2','00000000-0000-4000-b000-00000000010c','Agbangnizoun','agbangnizoun','city','BJ',7.07,1.98,'[]','benin-geography','com:agbangnizoun'),
('00000000-0000-4000-b000-0000000001c3','00000000-0000-4000-b000-00000000010c','Bohicon','bohicon','city','BJ',7.18,2.07,'["Bohikon"]','benin-geography','com:bohicon'),
('00000000-0000-4000-b000-0000000001c4','00000000-0000-4000-b000-00000000010c','Covè','cove','city','BJ',7.22,2.34,'["Cove"]','benin-geography','com:cove'),
('00000000-0000-4000-b000-0000000001c5','00000000-0000-4000-b000-00000000010c','Djidja','djidja','city','BJ',7.34,1.93,'[]','benin-geography','com:djidja'),
('00000000-0000-4000-b000-0000000001c6','00000000-0000-4000-b000-00000000010c','Ouinhi','ouinhi','city','BJ',7.10,2.45,'[]','benin-geography','com:ouinhi'),
('00000000-0000-4000-b000-0000000001c7','00000000-0000-4000-b000-00000000010c','Za-Kpota','za-kpota','city','BJ',7.23,2.21,'["Zakpota"]','benin-geography','com:za-kpota'),
('00000000-0000-4000-b000-0000000001c8','00000000-0000-4000-b000-00000000010c','Zangnanado','zangnanado','city','BJ',7.26,2.43,'[]','benin-geography','com:zangnanado'),
('00000000-0000-4000-b000-0000000001c9','00000000-0000-4000-b000-00000000010c','Zogbodomey','zogbodomey','city','BJ',7.08,2.12,'[]','benin-geography','com:zogbodomey');
