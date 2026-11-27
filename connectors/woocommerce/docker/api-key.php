<?php
/**
 * A REST API key for the admin user: Read by default, Read/Write with `read_write` as the argument
 * (#3136, printed under `WOOCOMMERCE_WRITE_…`, for the live test's writes), stored the way WooCommerce stores one it creates: the
 * consumer key hashed with `wc_api_hash`, the secret as it is, the last seven characters kept for
 * the settings screen. Printed once, for the live test's environment.
 */
global $wpdb;
$permissions = ( $args[0] ?? 'read' ) === 'read_write' ? 'read_write' : 'read';
$prefix      = 'read_write' === $permissions ? 'WOOCOMMERCE_WRITE_' : 'WOOCOMMERCE_';
$key    = 'ck_' . wc_rand_hash();
$secret = 'cs_' . wc_rand_hash();
$wpdb->insert(
	$wpdb->prefix . 'woocommerce_api_keys',
	array(
		'user_id'         => 1,
		'description'     => 'substrat live test',
		'permissions'     => $permissions,
		'consumer_key'    => wc_api_hash( $key ),
		'consumer_secret' => $secret,
		'truncated_key'   => substr( $key, -7 ),
	),
	array( '%d', '%s', '%s', '%s', '%s', '%s' )
);
echo "{$prefix}CONSUMER_KEY=$key\n{$prefix}CONSUMER_SECRET=$secret\n";
