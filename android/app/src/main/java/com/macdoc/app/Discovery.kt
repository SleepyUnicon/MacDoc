package com.macdoc.app

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

/**
 * LAN discovery client.
 *
 * These constants MUST match src/discovery.js on the host. `verify-android.mjs`
 * asserts that agreement so the two implementations cannot drift apart
 * silently — a mismatch here would make the app simply never find the PC.
 */
object Discovery {
    const val PORT = 41234
    const val PROBE = "macdoc:discover:v1"
    const val REPLY_PREFIX = "macdoc:here:v1:"

    private const val TIMEOUT_MS = 1500
    private const val ATTEMPTS = 3

    /**
     * Each active IPv4 network's own broadcast address (for example
     * 192.168.1.255), then the limited broadcast. Many access points and
     * Android builds drop 255.255.255.255 but pass the subnet broadcast.
     */
    fun broadcastTargets(): List<InetAddress> {
        val targets = mutableListOf<InetAddress>()
        try {
            for (nic in NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()) {
                if (!nic.isUp || nic.isLoopback) continue
                for (address in nic.interfaceAddresses) {
                    if (address.address is Inet4Address) address.broadcast?.let(targets::add)
                }
            }
        } catch (_: Exception) { /* fall back to the limited broadcast */ }
        targets.add(InetAddress.getByName("255.255.255.255"))
        return targets.distinct()
    }

    /** Parse a reply datagram into an endpoint, or null if it is not ours. */
    fun parseReply(message: String): String? {
        if (!message.startsWith(REPLY_PREFIX)) return null
        val endpoint = message.removePrefix(REPLY_PREFIX).trim()
        return EndpointPolicy.normalize(endpoint)
    }

    /**
     * Broadcast a probe and return the first valid endpoint, or null.
     * Runs on a background thread; never call from the main thread.
     */
    fun find(reachable: (String) -> Boolean): String? = try {
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = TIMEOUT_MS
            val payload = PROBE.toByteArray()
            val targets = broadcastTargets()

            repeat(ATTEMPTS) {
                try {
                    for (target in targets) {
                        try { socket.send(DatagramPacket(payload, payload.size, target, PORT)) } catch (_: java.io.IOException) { /* try the next address */ }
                    }
                    val buffer = ByteArray(256)
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)
                    val reply = String(packet.data, 0, packet.length)
                    parseReply(reply)?.takeIf(reachable)?.let { return it }
                } catch (_: SocketTimeoutException) {
                    // try again
                } catch (_: java.io.IOException) {
                    return null
                }
            }
        }
        null
    } catch (_: java.io.IOException) { null }
}
