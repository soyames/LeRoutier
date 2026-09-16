import { Link } from 'react-router';
import { Card, SectionTitle } from '@leroutier/ui';

const UPDATED = '16 septembre 2026';
const SUPPORT_EMAIL = 'leroutierbj@gmail.com';

function LegalLayout({ title, intro, children }) {
  return <div className="stack" style={{ maxWidth: 920, margin: '0 auto' }}>
    <Card className="stack">
      <SectionTitle title={title}/>
      {intro && <p className="muted">{intro}</p>}
      <p className="small muted">Version du {UPDATED}</p>
    </Card>
    {children}
    <LegalFooter/>
  </div>;
}

function Section({ title, children }) {
  return <Card className="stack">
    <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{title}</h2>
    {children}
  </Card>;
}

function P({ children }) { return <p style={{ margin: 0 }}>{children}</p>; }
function List({ children }) { return <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>{children}</ul>; }

export function LegalFooter() {
  return <footer aria-label="Informations légales" className="small muted" style={{ padding: '18px 4px 6px', textAlign: 'center' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '10px 16px' }}>
      <Link to="/legal">Mentions légales</Link>
      <Link to="/privacy">Confidentialité</Link>
      <Link to="/terms">Conditions d’utilisation</Link>
      <Link to="/cancellations">Annulations et remboursements</Link>
      <Link to="/cookies">Cookies et technologies</Link>
    </div>
    <p style={{ margin: '10px 0 0' }}>LeRoutier est exploité par DIGITAL CONDORDIA, Bénin.</p>
  </footer>;
}

export function LegalNotice() {
  return <LegalLayout title="Mentions légales" intro="Informations sur l’éditeur et l’exploitation de la plateforme LeRoutier.">
    <Section title="Éditeur de la plateforme">
      <P><strong>DIGITAL CONDORDIA</strong></P>
      <P>Entreprise immatriculée au Registre du Commerce et du Crédit Mobilier d’Abomey-Calavi sous le numéro <strong>RB/ABC/21 A 28773</strong>, immatriculation du 25 mars 2021.</P>
      <P>Adresse déclarée : Carré sans bornes, Maison Amevi Sossou, Ahouato, Ouèdo, Abomey-Calavi, Atlantique, Bénin.</P>
      <P>Contact LeRoutier : <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</P>
    </Section>
    <Section title="Objet de LeRoutier">
      <P>LeRoutier fournit une plateforme numérique de recherche de trajets, réservation, suivi de voyage, gestion de services de transport, suivi de colis et outils destinés aux opérateurs de transport, chauffeurs, convoyeurs et voyageurs.</P>
      <P>Lorsqu’un trajet est exécuté par un transporteur, une compagnie ou un chauffeur indépendant identifié dans la réservation, ce prestataire est responsable de l’exécution matérielle du transport dans les limites prévues par la loi et par les conditions applicables au service. DIGITAL CONDORDIA exploite la plateforme LeRoutier et n’est pas réputée transporteur pour un trajet sauf indication expresse contraire.</P>
    </Section>
    <Section title="Infrastructure et prestataires techniques">
      <P>LeRoutier peut s’appuyer sur des prestataires techniques pour l’hébergement, la base de données, l’authentification, le paiement, les cartes, les notifications et certaines fonctions d’assistance. Ces prestataires n’acquièrent aucun droit de propriété sur les données de l’utilisateur du seul fait de leur traitement technique.</P>
    </Section>
    <Section title="Propriété intellectuelle">
      <P>La marque, l’interface, les éléments graphiques, textes, logiciels et contenus propres à LeRoutier sont protégés dans la mesure prévue par la législation applicable. Les marques, cartes, données ou contenus appartenant à des tiers restent la propriété de leurs titulaires respectifs.</P>
    </Section>
  </LegalLayout>;
}

export function PrivacyPolicy() {
  return <LegalLayout title="Politique de confidentialité" intro="Cette politique explique quelles données LeRoutier traite, pourquoi elles sont utilisées et quels choix vous avez.">
    <Section title="1. Responsable du traitement">
      <P>Pour les traitements déterminés par la plateforme LeRoutier, le responsable est DIGITAL CONDORDIA, Bénin. Vous pouvez nous contacter à <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> pour toute question relative à la vie privée ou à vos données.</P>
      <P>La protection des données est notamment encadrée au Bénin par le Code du numérique et les règles applicables à la protection des données à caractère personnel.</P>
    </Section>
    <Section title="2. Données que nous pouvons traiter">
      <List>
        <li>Données de compte : identifiant, nom d’affichage, email, téléphone lorsque celui-ci est fourni ou vérifié.</li>
        <li>Données de réservation : trajet, service, arrêts, date, statut, référence de réservation et informations nécessaires à l’embarquement.</li>
        <li>Données de paiement : statut, montant, devise, référence et informations techniques nécessaires au rapprochement. Les informations sensibles de carte ou de portefeuille sont traitées par le prestataire de paiement lorsque celui-ci les collecte directement.</li>
        <li>Données de colis : référence, étapes de garde, statuts et informations minimales nécessaires à l’expéditeur et au destinataire.</li>
        <li>Données d’exploitation : véhicule, équipage, incidents, scans, opérations de gare et informations nécessaires à la sécurité du service.</li>
        <li>Données de localisation : position du véhicule et, lorsque la fonctionnalité l’exige et que l’autorisation est accordée, localisation nécessaire à l’itinéraire ou au suivi. La position privée du domicile d’un voyageur n’est pas communiquée aux opérateurs comme donnée d’exploitation.</li>
        <li>Données techniques : adresse IP, type d’appareil, événements de sécurité, journaux nécessaires au fonctionnement, à la prévention des abus et au diagnostic.</li>
      </List>
    </Section>
    <Section title="3. Pourquoi nous utilisons ces données">
      <List>
        <li>Créer et gérer un compte et vérifier l’identité d’un utilisateur.</li>
        <li>Rechercher des départs, créer et exécuter des réservations et billets.</li>
        <li>Traiter les paiements, rapprochements, remboursements autorisés et règlements.</li>
        <li>Afficher le suivi d’un véhicule, d’un voyage ou d’un colis et calculer des estimations lorsque les données le permettent.</li>
        <li>Envoyer des notifications de service, de retard, de paiement, d’embarquement ou de colis.</li>
        <li>Prévenir la fraude, les abus, les doubles opérations et les accès non autorisés.</li>
        <li>Fournir l’assistance, traiter les réclamations et documenter les incidents.</li>
        <li>Respecter nos obligations légales, réglementaires et comptables.</li>
        <li>Améliorer la fiabilité et l’ergonomie du service à partir de mesures agrégées ou minimisées.</li>
      </List>
    </Section>
    <Section title="4. Authentification Google et Firebase">
      <P>Lorsque vous choisissez une connexion gérée par Google ou Firebase Authentication, LeRoutier reçoit uniquement les informations nécessaires à l’authentification et au profil que vous avez autorisées, par exemple un identifiant de compte, votre email et des informations de profil de base. LeRoutier ne demande pas l’accès à Gmail, Google Drive, Google Calendar ou à d’autres contenus Google qui ne sont pas nécessaires à la connexion.</P>
      <P>Les rôles LeRoutier restent déterminés dans notre propre système. Une information de rôle provenant d’un fournisseur d’identité ne permet pas de devenir administrateur, opérateur, chauffeur ou convoyeur.</P>
    </Section>
    <Section title="5. Prestataires et destinataires">
      <P>Nous partageons uniquement les données nécessaires avec les personnes et prestataires qui doivent intervenir pour fournir le service. Il peut s’agir du transporteur chargé du trajet, du prestataire de paiement, de l’hébergeur, du service de base de données, du fournisseur d’identité, de services de cartes et d’itinéraires, de fournisseurs de notification et, lorsque cela est activé, d’un opérateur ou agrégateur USSD.</P>
      <P>Pour les fonctions d’assistance agentique, les modèles externes reçoivent des données opérationnelles minimisées. LeRoutier est conçu pour ne pas leur transmettre directement le nom, le téléphone, l’email, les coordonnées privées, les secrets de paiement ou d’autres identifiants personnels non nécessaires.</P>
    </Section>
    <Section title="6. Localisation et suivi des véhicules">
      <P>La localisation d’un véhicule peut être traitée pendant un service actif pour afficher sa progression, estimer l’arrivée, améliorer la coordination et gérer un incident. Les accès sont limités selon les rôles et l’opérateur concerné. Les données de localisation ne doivent pas être utilisées pour surveiller une personne en dehors des finalités opérationnelles autorisées.</P>
    </Section>
    <Section title="7. Conservation">
      <P>Nous conservons les données pendant la durée nécessaire à la finalité pour laquelle elles ont été collectées, à la sécurité du service, au traitement des litiges et aux obligations légales ou comptables applicables. Les durées peuvent différer selon la catégorie de données. Lorsque la conservation n’est plus nécessaire, les données sont supprimées, anonymisées ou rendues inaccessibles conformément aux procédures applicables.</P>
    </Section>
    <Section title="8. Transferts et hébergement hors du Bénin">
      <P>Certains prestataires cloud peuvent traiter ou héberger des données en dehors du Bénin. Dans ce cas, LeRoutier limite les données partagées et met en place les mesures contractuelles, organisationnelles et techniques requises par le droit applicable.</P>
    </Section>
    <Section title="9. Vos droits">
      <P>Selon la législation applicable, vous pouvez notamment demander l’accès à vos données, leur rectification, leur mise à jour, leur suppression lorsque la loi le permet, vous opposer à certains traitements, retirer un consentement lorsque le traitement repose sur celui-ci, ou demander des informations sur l’utilisation de vos données.</P>
      <P>Envoyez votre demande à <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Une vérification raisonnable de l’identité peut être demandée afin d’éviter qu’un tiers accède à vos informations. Vous pouvez également exercer les recours prévus auprès de l’autorité béninoise compétente en matière de protection des données.</P>
    </Section>
    <Section title="10. Sécurité">
      <P>LeRoutier applique des contrôles d’accès, séparation des rôles, chiffrement des connexions, journalisation, validation des paiements côté serveur, limitation de débit et mécanismes d’audit. Aucun système n’est toutefois exempt de risque. Nous vous demandons de protéger vos moyens d’authentification et de nous signaler rapidement tout accès suspect.</P>
    </Section>
    <Section title="11. Modifications">
      <P>Cette politique peut être mise à jour pour refléter une évolution du service, de nos prestataires ou de la réglementation. La date de la version en vigueur est affichée en haut de cette page. Les changements importants seront signalés par un moyen approprié.</P>
    </Section>
  </LegalLayout>;
}

export function TermsOfUse() {
  return <LegalLayout title="Conditions d’utilisation et de réservation" intro="Ces conditions encadrent l’utilisation de LeRoutier, les réservations réalisées sur la plateforme et les relations avec les opérateurs de transport.">
    <Section title="1. Champ d’application">
      <P>En utilisant LeRoutier, vous acceptez les présentes conditions pour l’accès à la plateforme. Une réservation de transport peut également être soumise aux conditions particulières de l’opérateur qui exécute le trajet, lorsque celles-ci vous sont présentées avant l’achat ou font partie des informations du service.</P>
    </Section>
    <Section title="2. Rôle de LeRoutier">
      <P>LeRoutier met en relation les voyageurs avec des opérateurs de transport et fournit des outils de réservation, paiement, suivi, exploitation et logistique. Sauf indication expresse contraire, DIGITAL CONDORDIA exploite la plateforme et n’exécute pas matériellement le transport. Le transporteur ou chauffeur indépendant identifié pour le service est responsable de l’exécution du trajet conformément à la loi et aux conditions applicables.</P>
    </Section>
    <Section title="3. Compte et informations fournies">
      <P>Vous devez fournir des informations exactes et tenir à jour celles qui sont nécessaires au service. Vous êtes responsable de l’utilisation de votre compte et devez signaler rapidement toute utilisation non autorisée. Les comptes, rôles et accès professionnels ne peuvent être cédés ou partagés de manière à contourner les contrôles d’autorisation.</P>
    </Section>
    <Section title="4. Recherche, prix et disponibilité">
      <P>Les horaires, prix, arrêts et capacités affichés sont fondés sur les informations enregistrées pour chaque service. La disponibilité d’une place n’est garantie qu’après la création et la confirmation de la réservation selon le statut affiché. Une information de recherche ou un écran de paiement en attente ne constitue pas à lui seul un billet confirmé.</P>
    </Section>
    <Section title="5. Paiement">
      <P>Pour les réservations voyageurs effectuées dans l’application, les paiements sont réalisés par les moyens en ligne proposés au moment de l’achat. Un paiement n’est considéré réussi qu’après confirmation vérifiée du prestataire de paiement. Le retour vers l’application, une capture d’écran, un SMS non vérifié ou une simple saisie utilisateur ne suffisent pas à confirmer un paiement.</P>
      <P>Les ventes au comptant réalisées par un équipage autorisé suivent un flux distinct et sont enregistrées pour le compte de l’opérateur concerné.</P>
    </Section>
    <Section title="6. Billet, embarquement et comportement">
      <P>Le voyageur doit présenter la référence, le billet ou le code requis et se présenter au point d’embarquement indiqué dans un délai raisonnable avant le départ. Il doit respecter les consignes de sécurité, le personnel, les autres voyageurs et les règles applicables à bord. Une fraude, falsification de billet, violence, menace ou comportement mettant en danger le service peut entraîner un refus d’embarquement ou les mesures prévues par la loi.</P>
    </Section>
    <Section title="7. Retards, changements et suivi">
      <P>Les heures d’arrivée et estimations sont indicatives lorsqu’elles dépendent du trafic, de la météo, des contrôles, de l’état des routes, d’un incident ou de la disponibilité du signal GPS. LeRoutier affiche les informations disponibles et peut envoyer des notifications lorsqu’un changement est enregistré. Une estimation ne constitue pas une garantie d’heure d’arrivée.</P>
    </Section>
    <Section title="8. Colis">
      <P>Un colis doit être décrit de manière sincère et emballé de façon adaptée. Sont interdits les objets dont le transport est illégal ainsi que les biens dangereux ou incompatibles avec le transport proposé. L’opérateur peut refuser un colis qui présente un risque pour les personnes, le véhicule, les autres biens ou le respect de la réglementation. Les règles particulières, limites et preuves de remise applicables au service de colis sont affichées lorsque disponibles.</P>
    </Section>
    <Section title="9. Annulation et remboursement">
      <P>Les conditions d’annulation ou de remboursement dépendent du statut de la réservation, du service et des règles applicables affichées au moment de l’achat. Un remboursement n’est jamais déclenché uniquement par une instruction libre ou par un modèle d’intelligence artificielle. Toute opération financière doit être validée par le système et, lorsque nécessaire, par une personne autorisée.</P>
      <P>Consultez également notre <Link to="/cancellations">politique d’annulation et de remboursement</Link>.</P>
    </Section>
    <Section title="10. Utilisation interdite de la plateforme">
      <List>
        <li>Contourner les contrôles d’accès ou tenter d’obtenir un rôle non autorisé.</li>
        <li>Créer de fausses réservations, manipuler les paiements ou abuser des remboursements.</li>
        <li>Extraire massivement les données ou perturber les services techniques.</li>
        <li>Utiliser la plateforme pour une activité illégale, frauduleuse ou portant atteinte aux droits d’un tiers.</li>
      </List>
    </Section>
    <Section title="11. Disponibilité et responsabilité">
      <P>Nous faisons des efforts raisonnables pour maintenir LeRoutier disponible et exact, mais des opérations de maintenance, pannes de réseau, défaillances d’un prestataire, coupures télécom ou événements de force majeure peuvent interrompre temporairement certaines fonctions. Rien dans ces conditions ne limite un droit ou une responsabilité qui ne peut légalement être limité.</P>
      <P>Les droits et recours du voyageur contre le transporteur pour l’exécution du transport restent ceux prévus par la législation applicable et, le cas échéant, par les conditions du transporteur.</P>
    </Section>
    <Section title="12. Droit applicable et réclamations">
      <P>Les présentes conditions sont régies par le droit applicable en République du Bénin, sous réserve des règles impératives qui pourraient s’appliquer. Pour une question ou une réclamation concernant LeRoutier, contactez <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Nous privilégions d’abord une résolution amiable lorsqu’elle est possible, sans priver l’utilisateur des recours prévus par la loi.</P>
    </Section>
    <Section title="13. Modifications">
      <P>Nous pouvons mettre à jour ces conditions pour tenir compte des évolutions de la plateforme, des prestataires ou de la réglementation. La version applicable à une réservation reste appréciée en fonction des conditions portées à votre connaissance au moment de l’opération concernée et des règles impératives applicables.</P>
    </Section>
  </LegalLayout>;
}

export function CancellationPolicy() {
  return <LegalLayout title="Annulations et remboursements" intro="Principes applicables aux demandes d’annulation et de remboursement effectuées via LeRoutier.">
    <Section title="Avant de demander une annulation">
      <P>Vérifiez le statut de votre réservation et les conditions particulières affichées pour le service. Certaines règles peuvent dépendre du transporteur, du délai avant départ, du type de service ou d’une annulation décidée par l’opérateur.</P>
    </Section>
    <Section title="Paiement en attente ou échoué">
      <P>Un paiement en attente n’est pas un paiement confirmé. Si le prestataire signale un échec, LeRoutier ne doit pas créer artificiellement une confirmation. En cas de débit apparent sans confirmation de réservation, contactez le support avec votre référence afin qu’un rapprochement soit effectué.</P>
    </Section>
    <Section title="Annulation par le voyageur">
      <P>Lorsque l’annulation est autorisée, le montant remboursable et les éventuels frais sont déterminés par les règles présentées pour le service et par la législation applicable. LeRoutier affiche le résultat disponible avant de finaliser une opération lorsque cette information est fournie par le système.</P>
    </Section>
    <Section title="Annulation ou impossibilité du service">
      <P>Lorsqu’un opérateur annule un service ou ne peut pas l’exécuter, LeRoutier peut proposer, selon les possibilités disponibles et les règles applicables, une information de remplacement, une réaffectation soumise à validation ou un traitement de remboursement. Les droits impératifs du voyageur restent applicables.</P>
    </Section>
    <Section title="Délai du remboursement">
      <P>Après validation d’un remboursement, son apparition sur votre moyen de paiement dépend aussi du prestataire de paiement, de l’opérateur de monnaie mobile ou de l’établissement concerné. LeRoutier ne marque un remboursement comme exécuté qu’à partir d’un état vérifié.</P>
    </Section>
    <Section title="Assistance">
      <P>Pour une demande, écrivez à <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> avec votre référence de réservation ou de paiement. Ne transmettez jamais votre mot de passe, code OTP ou secret de portefeuille.</P>
    </Section>
  </LegalLayout>;
}

export function CookiePolicy() {
  return <LegalLayout title="Cookies et technologies similaires" intro="Informations sur le stockage technique utilisé par LeRoutier et par certains services tiers.">
    <Section title="Fonctionnement essentiel">
      <P>LeRoutier peut utiliser des mécanismes de stockage local, de cache PWA ou des technologies équivalentes strictement nécessaires au fonctionnement, à la sécurité, aux préférences et à la continuité de l’expérience. Les jetons d’authentification de l’application sont conçus pour ne pas être conservés durablement dans le navigateur lorsqu’une conservation n’est pas nécessaire.</P>
    </Section>
    <Section title="Mesure et publicité">
      <P>LeRoutier n’utilise pas, dans sa configuration actuelle, de cookies publicitaires destinés à établir un profil publicitaire intersites. Si cette pratique devait changer, cette page et les mécanismes de consentement seraient mis à jour avant activation lorsque la loi l’exige.</P>
    </Section>
    <Section title="Services tiers">
      <P>Une redirection vers un fournisseur d’identité, un prestataire de paiement, un service de carte ou un autre service externe peut entraîner l’utilisation de cookies ou de stockage sous la responsabilité de ce fournisseur. Ses propres informations de confidentialité s’appliquent alors à son domaine.</P>
    </Section>
    <Section title="Vos réglages">
      <P>Vous pouvez contrôler ou supprimer les cookies et données de site depuis votre navigateur. La suppression d’un stockage strictement nécessaire peut interrompre une session, réinitialiser une préférence ou nécessiter une nouvelle authentification.</P>
    </Section>
  </LegalLayout>;
}
