#!/usr/bin/liquidsoap

log("################################: " ^ getenv("STATION_NAME"))

harbor_port=4444
harbor_user="user"
harbor_password="hackmehackme"

srt_port=9999
srt_password="hackmehackme"

radio_name="Radio Z"
radio_desc="Freies Radio aus Nürnberg - 95,8MHz | Kabel | DAB+ - https://radio-z.net"
radio_genre="freestyle"
radio_host="tsing-tux"
radio_url="http://#{radio_host}"

icecast_host="tsing-tux"
icecast_port=8800
icecast_password="hackmehackme"

log("calling apply_metadata")
