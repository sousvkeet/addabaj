package com.addakhana.app.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** This phone's own choices: the theme (dark unless the person chose light). */
object UiPrefs {
    private lateinit var context: Context
    private val _theme = MutableStateFlow("dark")
    val theme: StateFlow<String> = _theme.asStateFlow()

    fun init(c: Context) {
        context = c.applicationContext
        _theme.value = prefs().getString("theme", "dark") ?: "dark"
    }

    private fun prefs() = context.getSharedPreferences("ui", Context.MODE_PRIVATE)

    fun setTheme(theme: String) {
        _theme.value = theme
        prefs().edit().putString("theme", theme).apply()
    }
}
