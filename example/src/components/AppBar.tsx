import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {colors} from '../theme';
import {Menu, type MenuItem} from './Menu';

type Props = {
  title: string;
  onBack?: () => void;
  menu?: MenuItem[];
};

export function AppBar({title, onBack, menu}: Props) {
  const [open, setOpen] = React.useState(false);
  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} style={styles.iconBtn}>
            <Text style={styles.icon}>←</Text>
          </TouchableOpacity>
        ) : null}
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.spacer} />
        {menu?.length ? (
          <TouchableOpacity
            onPress={() => setOpen(true)}
            style={styles.iconBtn}>
            <Text style={styles.icon}>⋮</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {menu ? (
        <Menu visible={open} items={menu} onClose={() => setOpen(false)} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {backgroundColor: colors.primary},
  bar: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  iconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {color: colors.onPrimary, fontSize: 22},
  title: {
    color: colors.onPrimary,
    fontSize: 20,
    fontWeight: '600',
    marginLeft: 8,
  },
  spacer: {flex: 1},
});
