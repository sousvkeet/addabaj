package com.addakhana.app

import android.app.Application
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade
import com.addakhana.app.data.UiPrefs

class AddaApp : Application(), SingletonImageLoader.Factory {
    override fun onCreate() {
        super.onCreate()
        UiPrefs.init(this)
        com.addakhana.app.data.Devices.init(this)
        com.addakhana.app.data.DataUse.init(this, Graph.scope)
        Graph.init(this)
        com.addakhana.app.data.Permissions.init(this)
    }

    /** Pictures (profile photos, files, link cards) come signed in, through the app's own OkHttp. */
    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { Graph.http })) }
            .crossfade(true)
            .build()
}
