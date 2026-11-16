#!/bin/sh
# Install WooCommerce into the compose store, seed a small catalogue and two orders, and print a
# Read API key as `KEY=value` lines on stdout. Everything else goes to stderr, so stdout is the
# env file the live test reads.
set -eu
exec 3>&1 1>&2

i=0
until [ -f /var/www/html/wp-config.php ] && wp db check >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -le 90 ] || { echo 'WordPress never became ready'; exit 1; }
  sleep 2
done

wp core install --url=http://localhost:8080 --title='Live test store' --admin_user=admin \
  --admin_password=admin --admin_email=admin@example.com --skip-email
wp rewrite structure '/%postname%/' --hard
wp plugin install woocommerce --version="$WOOCOMMERCE_VERSION" --activate
wp plugin verify-checksums woocommerce
wp option update woocommerce_currency SEK

w() { wp wc "$@" --user=admin --porcelain; }
simple=$(w product create --name='Mugg Åre' --type=simple --sku=MUG-1 --regular_price=149.00 --sale_price=129.00)
shirt=$(w product create --name='T-shirt' --type=variable \
  --attributes='[{"name":"Size","options":["M","L"],"variation":true,"visible":true}]')
w product_variation create "$shirt" --sku=TS-M --regular_price=199.00 --attributes='[{"name":"Size","option":"M"}]' >/dev/null
large=$(w product_variation create "$shirt" --sku=TS-L --regular_price=249.00 --sale_price=219.50 \
  --attributes='[{"name":"Size","option":"L"}]')
w product create --name='Presentkort' --type=simple --status=draft >/dev/null

billing='{"first_name":"Åsa","last_name":"Ångström","address_1":"Storgatan 1","city":"Umeå","postcode":"903 26","country":"SE","email":"asa@example.com"}'
w shop_order create --status=processing --set_paid=true --billing="$billing" \
  --line_items="[{\"product_id\":$simple,\"quantity\":2},{\"product_id\":$shirt,\"variation_id\":$large,\"quantity\":1}]" >/dev/null
w shop_order create --status=cancelled --line_items="[{\"product_id\":$simple,\"quantity\":1}]" >/dev/null

# One product and one order in the trash, one of each deleted for good (#3224). Their ids go to the
# env file, so the live test can ask the store about exactly them.
trashed_product=$(w product create --name='Kasserad' --type=simple --regular_price=10.00)
deleted_product=$(w product create --name='Borttagen' --type=simple --regular_price=10.00)
trashed_order=$(w shop_order create --status=pending --line_items="[{\"product_id\":$simple,\"quantity\":1}]")
deleted_order=$(w shop_order create --status=pending --line_items="[{\"product_id\":$simple,\"quantity\":1}]")
wp wc product delete "$trashed_product" --user=admin >/dev/null
wp wc product delete "$deleted_product" --force=true --user=admin >/dev/null
wp wc shop_order delete "$trashed_order" --user=admin >/dev/null
wp wc shop_order delete "$deleted_order" --force=true --user=admin >/dev/null
printf 'WOOCOMMERCE_TRASHED_PRODUCT=%s\nWOOCOMMERCE_DELETED_PRODUCT=%s\nWOOCOMMERCE_TRASHED_ORDER=%s\nWOOCOMMERCE_DELETED_ORDER=%s\n' \
  "$trashed_product" "$deleted_product" "$trashed_order" "$deleted_order" >&3

wp eval-file /seed/api-key.php >&3
