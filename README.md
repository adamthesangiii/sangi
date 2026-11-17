# Zákazky a nakládky – Redi-Rock & ZEMKOP

Mobilná webová aplikácia na zápis nakládok blokov (Redi-Rock a ZEMKOP blok) k zákazkám:
kto nakladal, kedy, aké bloky a koľko kusov, súčty v kusoch aj tonách.

## Ako to beží
- `public/` – samotná aplikácia (jedna stránka, funguje na telefóne, dá sa pridať na plochu).
- `functions/api/[[path]].js` – Cloudflare Pages Function, ktorá ukladá dáta do databázy D1.
- `lib/seed.js` – katalóg 128 blokov; nahrá sa do prázdnej databázy automaticky pri prvom spustení.

## Nasadenie na Cloudflare Pages
1. Cloudflare → **Storage & Databases → D1** → Create database `zemkop-nakladky`.
2. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** → vyberte tento repozitár.
   - Framework preset: *None*, Build command: prázdne, Build output directory: `public`.
3. V Pages projekte → **Settings → Bindings → Add → D1 database**: Variable name `DB`, databáza `zemkop-nakladky`.
4. **Settings → Variables and Secrets → Add**: `APP_PIN` (typ Secret) = PIN, ktorým sa prihlasujú pracovníci.
5. **Deployments → Retry deployment** (aby sa väzby prejavili). Hotovo – aplikácia beží na `https://<projekt>.pages.dev`.

Tabuľka v D1 sa vytvorí sama pri prvej požiadavke.

## Lokálne spustenie
```
echo 'APP_PIN=1234' > .dev.vars
npx wrangler pages dev public --d1 DB
```
