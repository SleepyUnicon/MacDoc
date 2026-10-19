package com.macdoc.app

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.webkit.CookieManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Updates MacDoc over Wi-Fi from the paired Mac.
 *
 * The Mac publishes new builds (npm run android:update); this checks on open
 * and every 30 minutes. When a newer build exists it shows a pop-up that can't
 * be dismissed: Update downloads the APK over the same PIN-protected
 * connection as the dock, checks its SHA-256, and installs it. Android asks
 * once for permission to install, and may ask to confirm each update.
 */
class AppUpdater(private val activity: Activity, private val endpoint: () -> String?) {
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var dialog: AlertDialog? = null
    private var message: TextView? = null
    private var progress: ProgressBar? = null
    private var button: Button? = null
    private var offer: JSONObject? = null
    private var busy = false
    private var lastCheck = 0L
    private val periodic = object : Runnable {
        override fun run() { check(force = true); main.postDelayed(this, CHECK_EVERY_MS) }
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION")
                    val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                    show("Tap Update on the next screen to finish.", null)
                    activity.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                PackageInstaller.STATUS_SUCCESS -> show("Updated. Open MacDoc again to use the new version.", null)
                else -> {
                    busy = false
                    val reason = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Android stopped the update."
                    show("The update didn't install: $reason", "Try again")
                }
            }
        }
    }

    fun start() {
        ContextCompat.registerReceiver(activity, receiver, IntentFilter(ACTION_STATUS), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    fun onResume() {
        main.removeCallbacks(periodic)
        main.postDelayed(periodic, CHECK_EVERY_MS)
        // Coming back from the "install unknown apps" setting: carry on.
        if (offer != null && !busy && dialog?.isShowing == true) show(readyText(), if (canInstall()) "Update now" else "Allow updates")
        check()
    }

    fun onPause() { main.removeCallbacks(periodic) }

    fun stop() {
        main.removeCallbacks(periodic)
        runCatching { activity.unregisterReceiver(receiver) }
        dialog?.dismiss()
        io.shutdownNow()
    }

    /** Ask the Mac whether a newer build is published. */
    fun check(force: Boolean = false) {
        val base = endpoint() ?: return
        val now = System.currentTimeMillis()
        if (busy || (!force && now - lastCheck < MIN_GAP_MS)) return
        lastCheck = now
        io.execute {
            val latest = runCatching { JSONObject(request("$base/api/app/latest").inputStream.bufferedReader().use { it.readText() }) }.getOrNull()
            if (latest == null || !latest.optBoolean("available") || latest.optInt("versionCode") <= BuildConfig.VERSION_CODE) return@execute
            main.post {
                if (busy || activity.isFinishing) return@post
                offer = latest
                show(readyText(), if (canInstall()) "Update now" else "Allow updates")
            }
        }
    }

    private fun readyText(): String {
        val latest = offer ?: return ""
        val notes = latest.optString("notes").takeIf { it.isNotBlank() }?.let { "\n\n$it" } ?: ""
        val permission = if (canInstall()) "" else "\n\nFirst, allow MacDoc to install updates: turn on \"Allow from this source\", then come back."
        return "MacDoc ${latest.optString("versionName")} (build ${latest.optInt("versionCode")}) is ready on your Mac. " +
            "You're on ${BuildConfig.VERSION_NAME} (build ${BuildConfig.VERSION_CODE}).$notes$permission"
    }

    private fun canInstall() = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

    private fun request(url: String): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 4000
        conn.readTimeout = 30000
        // The dock's pairing cookie lives in the WebView; reuse it so only paired tablets can download.
        CookieManager.getInstance().getCookie(url)?.let { conn.setRequestProperty("Cookie", it) }
        if (conn.responseCode != 200) throw IllegalStateException("HTTP ${conn.responseCode}")
        return conn
    }

    /** The pop-up has no cancel button and ignores Back and outside taps. */
    private fun show(text: String, action: String?) {
        if (dialog == null) {
            val dp = activity.resources.displayMetrics.density
            val box = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding((24 * dp).toInt(), (8 * dp).toInt(), (24 * dp).toInt(), (16 * dp).toInt())
            }
            message = TextView(activity).apply { textSize = 15f }
            progress = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; visibility = android.view.View.GONE }
            button = Button(activity).apply { isAllCaps = false; setOnClickListener { act() } }
            box.addView(message)
            box.addView(progress, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = (16 * dp).toInt() })
            box.addView(button, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = (16 * dp).toInt(); gravity = Gravity.END })
            dialog = AlertDialog.Builder(activity).setTitle("Update MacDoc").setView(box).setCancelable(false).create().apply {
                setCanceledOnTouchOutside(false)
            }
        }
        message?.text = text
        button?.text = action ?: ""
        button?.visibility = if (action == null) android.view.View.GONE else android.view.View.VISIBLE
        if (dialog?.isShowing != true && !activity.isFinishing) dialog?.show()
    }

    private fun act() {
        if (!canInstall()) {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
            return
        }
        val latest = offer ?: return
        val base = endpoint() ?: return show("Reconnect to your Mac, then try again.", "Try again")
        busy = true
        show("Downloading the update…", null)
        progress?.visibility = android.view.View.VISIBLE
        progress?.progress = 0
        io.execute {
            try {
                val file = File(activity.cacheDir, "update.apk")
                val conn = request("$base/api/app/apk")
                val total = conn.contentLengthLong.takeIf { it > 0 } ?: latest.optLong("bytes")
                val digest = MessageDigest.getInstance("SHA-256")
                conn.inputStream.use { input ->
                    file.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var done = 0L
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            digest.update(buffer, 0, read)
                            done += read
                            if (total > 0) main.post { progress?.progress = (done * 100 / total).toInt() }
                        }
                    }
                }
                val sha = digest.digest().joinToString("") { "%02x".format(it) }
                if (sha != latest.optString("sha256")) throw IllegalStateException("the download didn't match what your Mac published")
                install(file)
            } catch (error: Exception) {
                main.post { busy = false; progress?.visibility = android.view.View.GONE; show("The update couldn't download: ${error.message}. Check the Wi-Fi and try again.", "Try again") }
            }
        }
    }

    private fun install(file: File) {
        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(activity.packageName)
            setSize(file.length())
            // Once MacDoc installed itself, Android can update it without another confirmation.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("MacDoc.apk", 0, file.length()).use { out ->
                file.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            val status = PendingIntent.getBroadcast(activity, id, Intent(ACTION_STATUS).setPackage(activity.packageName), flags)
            main.post { show("Installing… MacDoc will close when it's done. Open it again from your home screen.", null); progress?.visibility = android.view.View.GONE }
            session.commit(status.intentSender)
        }
    }

    private companion object {
        const val ACTION_STATUS = "com.macdoc.app.UPDATE_STATUS"
        const val CHECK_EVERY_MS = 30 * 60 * 1000L
        const val MIN_GAP_MS = 60 * 1000L
    }
}
