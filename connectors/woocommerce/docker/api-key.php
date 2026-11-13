<?php
/**
 * A Read REST API key for the admin user, stored the way WooCommerce stores one it creates: the
 * consumer key hashed with `wc_api_hash`, the secret as it is, the last seven characters kept for
 * the settings screen. Printed once, for the live test's environment.
 */
global $wpdb;
$key    = 'ck_' . wc_rand_hash();
$secret = 'cs_' . wc_rand_hash();
$wpdb->insert(
	$wpdb->prefix . 'woocommerce_api_keys',
	array(
		'user_id'         => 1,
		'description'     => 'substrat live test',
		'permissions'     => 'read',
		'consumer_key'    => wc_api_hash( $key ),
		'consumer_secret' => $secret,
		'truncated_key'   => substr( $key, -7 ),
	),
	array( '%d', '%s', '%s', '%s', '%s', '%s' )
);
echo "WOOCOMMERCE_CONSUMER_KEY=$key\nWOOCOMMERCE_CONSUMER_SECRET=$secret\n";
